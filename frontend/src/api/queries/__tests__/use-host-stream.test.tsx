/**
 * Lane F — useHostStream / useCompositeStream / useHostStreamEvents
 *
 * Verifies the SSE → TanStack Query bridge:
 *   - mutation writes events to the cache under
 *     `['host-stream', requestId]` as they arrive
 *   - subscriber `useHostStreamEvents(requestId)` reads them
 *   - malformed events surface as a synthetic fatal in the cache
 *     (not silent undefined) and throw so .error is set
 *   - default retry: 0 (generation POSTs must not duplicate jobs)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const streamHostMock = vi.hoisted(() => vi.fn());
const streamCompositeMock = vi.hoisted(() => vi.fn());
vi.mock('../../host', () => ({
  streamHost: (...args: unknown[]) => streamHostMock(...args),
}));
vi.mock('../../composite', () => ({
  streamComposite: (...args: unknown[]) => streamCompositeMock(...args),
}));

import {
  useHostStream,
  useHostStreamEvents,
  useCompositeStream,
} from '../use-host-stream';

afterEach(() => {
  vi.clearAllMocks();
});

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  });
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

async function* asyncIter<T>(items: T[]): AsyncGenerator<T> {
  for (const it of items) yield it;
}

describe('useHostStream — SSE → TQ bridge', () => {
  it('writes parsed events under [host-stream, requestId]', async () => {
    streamHostMock.mockImplementation(() =>
      asyncIter([
        { type: 'init', seeds: [1, 2], batch_id: 'b-1' },
        { type: 'candidate', seed: 1, path: '/p/host_a.png', url: '/u/host_a.png', batch_id: 'b-1' },
        { type: 'done', total: 4, min_success_met: true, batch_id: 'b-1' },
      ]),
    );

    const client = makeClient();
    const Wrapper = wrapper(client);
    const { result: mutResult } = renderHook(() => useHostStream(), { wrapper: Wrapper });
    const { result: subResult, rerender } = renderHook(
      () => useHostStreamEvents('req-1'),
      { wrapper: Wrapper },
    );

    await mutResult.current.mutateAsync({
      input: { mode: 'text', prompt: '안녕' },
      requestId: 'req-1',
    });

    rerender();
    const events = client.getQueryData<unknown[]>(['host-stream', 'req-1']);
    expect(events).toHaveLength(3);
    // First event is the init — wire batch_id → batchId.
    expect((events![0] as { batchId: string }).batchId).toBe('b-1');
    // Subscriber sees the same data.
    expect(subResult.current.data?.length).toBe(3);
  });

  it('surfaces a malformed event as fatal in the cache + throws', async () => {
    streamHostMock.mockImplementation(() =>
      asyncIter([
        { type: 'init', seeds: [1] },
        // wrong shape — missing required fields for candidate
        { type: 'candidate', seed: 'not-a-number' },
      ]),
    );

    const client = makeClient();
    const Wrapper = wrapper(client);
    const { result: mutResult } = renderHook(() => useHostStream(), { wrapper: Wrapper });

    await expect(
      mutResult.current.mutateAsync({
        input: { mode: 'text', prompt: '안녕' },
        requestId: 'req-fatal',
      }),
    ).rejects.toThrow();

    const events = client.getQueryData<{ type: string }[]>(['host-stream', 'req-fatal']);
    expect(events?.[1]?.type).toBe('fatal');
  });

  it('useCompositeStream writes under [composite-stream, requestId]', async () => {
    streamCompositeMock.mockImplementation(() =>
      asyncIter([
        { type: 'init', seeds: [10] },
        { type: 'done', total: 1, min_success_met: true },
      ]),
    );

    const client = makeClient();
    const Wrapper = wrapper(client);
    const { result } = renderHook(() => useCompositeStream(), { wrapper: Wrapper });

    await result.current.mutateAsync({
      input: {
        host: { selectedPath: '/p/host.png' },
        background: { source: 'prompt', prompt: '거실' },
      },
      requestId: 'req-c-1',
    });

    const events = client.getQueryData<unknown[]>(['composite-stream', 'req-c-1']);
    expect(events).toHaveLength(2);
  });

  it('does not auto-retry — generation POSTs must not duplicate jobs', async () => {
    streamHostMock.mockImplementation(() => {
      // Iterator that throws as soon as it's awaited — a network-level
      // failure on the very first read.
      // eslint-disable-next-line @typescript-eslint/require-await
      return (async function* () {
        throw new Error('boom');
      })();
    });

    const client = makeClient();
    const Wrapper = wrapper(client);
    const { result } = renderHook(() => useHostStream(), { wrapper: Wrapper });

    await expect(
      result.current.mutateAsync({
        input: { mode: 'text', prompt: '안녕' },
        requestId: 'req-noretry',
      }),
    ).rejects.toThrow(/boom/);

    expect(streamHostMock).toHaveBeenCalledTimes(1);
  });
});
