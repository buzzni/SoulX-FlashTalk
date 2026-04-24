/**
 * useUploadReferenceImage — stale-result rejection contract.
 *
 * The bug this hook prevents: user drops file A, immediately drops
 * file B, upload A finishes LAST, overwriting B's path with A's.
 * AbortController alone doesn't fix it (A's request was already on
 * the wire). Epoch guard does.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useUploadReferenceImage } from '../useUploadReferenceImage';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('useUploadReferenceImage', () => {
  it('happy path: upload resolves, result + isLoading update', async () => {
    const uploadFn = async () => ({ path: '/srv/a.png', url: '/api/files/a.png' });
    const { result } = renderHook(() => useUploadReferenceImage(uploadFn));
    let res;
    await act(async () => {
      res = await result.current.upload(new Blob(['x']));
    });
    expect(res).toEqual({ path: '/srv/a.png', url: '/api/files/a.png' });
    expect(result.current.result).toEqual({ path: '/srv/a.png', url: '/api/files/a.png' });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('stale-result rejection: fileA late resolve does NOT overwrite fileB', async () => {
    const a = deferred();
    const b = deferred();
    const calls = [];
    const uploadFn = async (file) => {
      calls.push(file);
      return calls.length === 1 ? a.promise : b.promise;
    };

    const { result } = renderHook(() => useUploadReferenceImage(uploadFn));

    // Kick off upload A, then upload B before A resolves.
    let pA, pB;
    act(() => { pA = result.current.upload(new Blob(['A'])); });
    act(() => { pB = result.current.upload(new Blob(['B'])); });

    // B resolves first — its result lands.
    await act(async () => {
      b.resolve({ path: '/srv/b.png' });
      await pB;
    });
    expect(result.current.result).toEqual({ path: '/srv/b.png' });

    // A resolves late — must NOT overwrite B's result.
    await act(async () => {
      a.resolve({ path: '/srv/a.png' });
      await pA;
    });
    expect(result.current.result).toEqual({ path: '/srv/b.png' });
  });

  it('abort() while in-flight: upload promise resolves null, state stays idle', async () => {
    const d = deferred();
    const uploadFn = async (_file, opts) => {
      opts?.signal?.addEventListener?.('abort', () => {
        d.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
      return d.promise;
    };
    const { result } = renderHook(() => useUploadReferenceImage(uploadFn));
    let p;
    act(() => { p = result.current.upload(new Blob(['x'])); });
    // The await MUST be inside act() — finally's setIsLoading(false)
    // fires when the promise settles; without act() wrapping, React
    // batches the update past our assertion and isLoading still
    // reads as `true`.
    let res;
    await act(async () => {
      result.current.abort();
      res = await p;
    });
    expect(res).toBeNull();
    expect(result.current.result).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('upload error: sets error, not result', async () => {
    const uploadFn = async () => {
      throw Object.assign(new Error('server on fire'), { status: 500 });
    };
    const { result } = renderHook(() => useUploadReferenceImage(uploadFn));
    await act(async () => {
      await result.current.upload(new Blob(['x']));
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.result).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('unmount aborts in-flight upload', async () => {
    const d = deferred();
    let signalSeen;
    const uploadFn = async (_file, opts) => {
      signalSeen = opts?.signal;
      opts?.signal?.addEventListener?.('abort', () => {
        d.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
      return d.promise;
    };
    const { result, unmount } = renderHook(() => useUploadReferenceImage(uploadFn));
    let p;
    act(() => { p = result.current.upload(new Blob(['x'])); });
    unmount();
    expect(signalSeen.aborted).toBe(true);
    // Promise still resolves (to null) via the aborted path.
    const res = await p;
    expect(res).toBeNull();
  });
});
