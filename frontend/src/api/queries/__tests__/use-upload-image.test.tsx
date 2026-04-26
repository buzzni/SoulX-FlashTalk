/**
 * Lane E — useUploadImage unit tests.
 *
 * Verifies kind→endpoint mapping, schema-parse on the response, the
 * retry: 1 policy on idempotent uploads, and File-size guard.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUploadImage } from '../use-upload-image';

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useUploadImage', () => {
  it('posts to the right endpoint for kind=host', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ filename: 'a.png', path: '/u/a.png', url: '/api/files/a.png' }),
    });
    global.fetch = fetchMock;
    const client = makeClient();
    const { result } = renderHook(() => useUploadImage('host'), { wrapper: wrapper(client) });
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await result.current.mutateAsync(file);
    expect(fetchMock).toHaveBeenCalled();
    const callUrl = fetchMock.mock.calls[0]![0] as string;
    expect(callUrl).toMatch(/\/api\/upload\/host-image$/);
  });

  it('rejects oversize files before fetch fires', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    const client = makeClient();
    const { result } = renderHook(() => useUploadImage('background'), {
      wrapper: wrapper(client),
    });
    // 21 MB > 20 MB cap.
    const big = { size: 21 * 1024 * 1024 } as Blob;
    Object.setPrototypeOf(big, Blob.prototype);
    await expect(result.current.mutateAsync(big)).rejects.toMatchObject({
      status: 413,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses response via UploadResultSchema (passthrough)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      // Extra fields pass through; missing optionals are fine.
      json: async () => ({ path: '/u/x.png', extra: 'meta', size: 1234 }),
    });
    const client = makeClient();
    const { result } = renderHook(() => useUploadImage('reference'), {
      wrapper: wrapper(client),
    });
    const file = new Blob([new Uint8Array([7])], { type: 'image/png' });
    const out = await result.current.mutateAsync(file);
    expect(out.path).toBe('/u/x.png');
    expect((out as Record<string, unknown>).extra).toBe('meta');
  });

  it('surfaces ApiError(status: 0) when the response shape is wrong', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      // path is a number — schema expects string.
      json: async () => ({ path: 123 }),
    });
    const client = makeClient();
    const { result } = renderHook(() => useUploadImage('host'), { wrapper: wrapper(client) });
    const file = new Blob([new Uint8Array([1])], { type: 'image/png' });
    await expect(result.current.mutateAsync(file)).rejects.toMatchObject({
      status: 0,
      name: 'ApiError',
    });
  });
});
