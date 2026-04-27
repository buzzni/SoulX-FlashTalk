/**
 * AbortController propagation — Phase 1 contract: every async api/*
 * call accepts `{signal}`, and aborting the signal short-circuits the
 * in-flight work AND stops any further state-dispatch callbacks.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchResult } from '../../api/result';
import { getVideoMeta } from '../../api/file';
import { streamHost } from '../../api/host';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Helper — a fetch stub that never resolves until the caller's signal
 * aborts. Mirrors real fetch semantics: if the signal is already
 * aborted at call time, reject synchronously; otherwise reject when the
 * abort event fires. */
function pendingFetchStub() {
  global.fetch = vi.fn((_url, init) => {
    const mkAbortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    const signal = init?.signal;
    if (signal?.aborted) {
      return Promise.reject(mkAbortError());
    }
    return new Promise((_, reject) => {
      signal?.addEventListener?.('abort', () => reject(mkAbortError()));
    });
  });
}

describe('api.abort — fetchResult', () => {
  it('aborts propagate as AbortError (caller pattern: try/catch and ignore)', async () => {
    pendingFetchStub();
    const controller = new AbortController();
    const call = fetchResult('task-1', { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('api.abort — getVideoMeta', () => {
  it('aborts re-throw from the wrapper (so useEffect cleanup can distinguish)', async () => {
    pendingFetchStub();
    const controller = new AbortController();
    const call = getVideoMeta('task-1', { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('network errors become `{}` (caller shows "—", no throw)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await getVideoMeta('task-1');
    expect(result).toEqual({});
  });
});

// `subscribeProgress` was retired in favour of `useTaskProgress` (TanStack
// Query) — its abort/cancel semantics are now covered by
// `src/api/queries/__tests__/use-task-progress.test.tsx`.

describe('api.abort — streamHost', () => {
  it('abort before iteration rejects the initial fetch', async () => {
    pendingFetchStub();
    const controller = new AbortController();
    controller.abort();
    const iter = streamHost({ mode: 'text', prompt: 'x' }, { signal: controller.signal });
    await expect(iter.next()).rejects.toBeDefined();
  });
});
