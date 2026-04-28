/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useJobSnapshot } from '../useJobSnapshot';
import { useJobCacheStore } from '../../stores/jobCacheStore';
import { _testActiveCount, _testReset } from '../../api/jobSubscription';

function neverResolvingFetch() {
  return vi.fn().mockImplementation(
    (_url: string, init: RequestInit) => {
      void init.signal; // capture signal so abort is observable
      return new Promise(() => { /* hang forever */ });
    },
  );
}

beforeEach(() => {
  _testReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  _testReset();
});

describe('useJobSnapshot', () => {
  it('subscribes on mount with non-null jobId', () => {
    vi.stubGlobal('fetch', neverResolvingFetch());
    expect(_testActiveCount()).toBe(0);
    const { unmount } = renderHook(() => useJobSnapshot('job-1'));
    expect(_testActiveCount()).toBe(1);
    unmount();
    expect(_testActiveCount()).toBe(0);
  });

  it('does not subscribe when jobId is null', () => {
    const fetchMock = neverResolvingFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useJobSnapshot(null));
    expect(_testActiveCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the stable EMPTY_ENTRY for null jobId across rerenders', () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useJobSnapshot(id),
      { initialProps: { id: null } },
    );
    const first = result.current;
    rerender({ id: null });
    expect(result.current).toBe(first); // referential equality
  });

  it('switches subscriptions when jobId changes A → B', () => {
    vi.stubGlobal('fetch', neverResolvingFetch());
    const { rerender, unmount } = renderHook(
      ({ id }: { id: string | null }) => useJobSnapshot(id),
      { initialProps: { id: 'job-A' } },
    );
    expect(_testActiveCount()).toBe(1);
    rerender({ id: 'job-B' });
    // The old A handle was closed; B opened. Net active count is still 1.
    expect(_testActiveCount()).toBe(1);
    unmount();
    expect(_testActiveCount()).toBe(0);
  });

  it('drops the subscription when jobId transitions to null', () => {
    vi.stubGlobal('fetch', neverResolvingFetch());
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) => useJobSnapshot(id),
      { initialProps: { id: 'job-1' as string | null } },
    );
    expect(_testActiveCount()).toBe(1);
    rerender({ id: null });
    expect(_testActiveCount()).toBe(0);
  });

  it('reflects cache mutations from subscription frames', () => {
    vi.stubGlobal('fetch', neverResolvingFetch());
    const { result } = renderHook(() => useJobSnapshot('job-1'));
    expect(result.current.snapshot).toBeNull();
    // Simulate a frame landing in the cache. act() flushes the React
    // scheduler so the zustand selector re-runs synchronously.
    act(() => {
      useJobCacheStore.getState().setSnapshot('job-1', {
        id: 'job-1',
        user_id: 'u1',
        kind: 'host',
        state: 'streaming',
        variants: [],
        prev_selected_image_id: null,
        batch_id: null,
        error: null,
        input_hash: null,
      }, 0);
    });
    expect(result.current.snapshot?.state).toBe('streaming');
  });
});
