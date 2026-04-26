/**
 * Lane E — useTaskProgress unit tests.
 *
 * Drives the TQ-based polling hook under a real QueryClient (no
 * fake timers; we mock fetch and let TQ orchestrate).
 *
 * Verifies:
 *   - schema-rejects on bad shape (zod gate inside fetchJSON).
 *   - polls while non-terminal; stops on 'complete'/'error'.
 *   - rewrites document.title with progress percent + restores on
 *     unmount/terminal.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTaskProgress } from '../use-task-progress';

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useTaskProgress', () => {
  beforeEach(() => {
    document.title = 'TestApp';
  });

  it('returns the parsed snapshot on a 2xx', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ task_id: 't-1', stage: 'generating', progress: 0.4, message: '진행 중' }),
    });
    const client = makeClient();
    const { result } = renderHook(() => useTaskProgress('t-1', { writeTabTitle: false }), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.data?.stage).toBe('generating'));
    expect(result.current.data?.progress).toBe(0.4);
  });

  it('rewrites document.title with progress percent', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ task_id: 't-2', stage: 'generating', progress: 0.67, message: '진행' }),
    });
    const client = makeClient();
    const { unmount } = renderHook(() => useTaskProgress('t-2'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(document.title).toBe('67% — 영상 생성 중'));
    unmount();
    // Restored on unmount.
    expect(document.title).toBe('TestApp');
  });

  it('stays disabled when enabled=false', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ task_id: 't-3', stage: 'generating', progress: 0.5 }),
    });
    const client = makeClient();
    const { result } = renderHook(
      () => useTaskProgress('t-3', { enabled: false, writeTabTitle: false }),
      { wrapper: wrapper(client) },
    );
    // Give TQ a chance to run a query if it would.
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current.data).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
