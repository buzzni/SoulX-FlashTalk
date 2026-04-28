/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useHostGeneration } from '../useHostGeneration';
import { useJobCacheStore, type JobSnapshot } from '../../stores/jobCacheStore';
import { useWizardStore } from '../../stores/wizardStore';
import { _testReset } from '../../api/jobSubscription';
import { INITIAL_HOST } from '../../wizard/schema';

function neverResolvingFetch() {
  return vi.fn().mockImplementation(
    (_url: string, init: RequestInit) => {
      void init?.signal;
      return new Promise(() => { /* hang */ });
    },
  );
}

function makeJobSnapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: 'job-1',
    user_id: 'u1',
    kind: 'host',
    state: 'streaming',
    variants: [],
    prev_selected_image_id: null,
    batch_id: null,
    error: null,
    input_hash: null,
    ...overrides,
  };
}

beforeEach(() => {
  _testReset();
  // Reset wizard store's host slice so tests start from a clean idle.
  useWizardStore.getState().setHost(() => ({ ...INITIAL_HOST }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  _testReset();
});

describe('useHostGeneration — deriveReturn', () => {
  it('returns empty state when host.generation is idle (no subscription)', () => {
    const { result } = renderHook(() => useHostGeneration());
    expect(result.current.variants).toEqual([]);
    expect(result.current.prevSelected).toBeNull();
    expect(result.current.batchId).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('returns empty state when attached but cache snapshot is null (mid-fetch)', () => {
    vi.stubGlobal('fetch', neverResolvingFetch());
    useWizardStore.getState().setHost((p) => ({
      ...p,
      generation: { state: 'attached', jobId: 'job-1' },
    }));
    const { result } = renderHook(() => useHostGeneration());
    // isLoading reflects the cache's beginLoading-on-subscribe.
    expect(result.current.variants).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it('projects variants from a cache snapshot', () => {
    vi.stubGlobal('fetch', neverResolvingFetch());
    useWizardStore.getState().setHost((p) => ({
      ...p,
      generation: { state: 'attached', jobId: 'job-1' },
    }));
    const { result } = renderHook(() => useHostGeneration());
    act(() => {
      useJobCacheStore.getState().setSnapshot('job-1', makeJobSnapshot({
        state: 'streaming',
        variants: [
          { image_id: 'v1', path: '/p/v1.png', url: '/u/v1.png', seed: 7 },
          { image_id: 'v2', path: '/p/v2.png', url: '/u/v2.png', seed: 11 },
        ],
      }), 0);
    });
    expect(result.current.variants).toHaveLength(2);
    expect(result.current.variants[0]?.imageId).toBe('v1');
    expect(result.current.variants[0]?.seed).toBe(7);
    expect(result.current.variants[0]?.placeholder).toBe(false);
    expect(result.current.isLoading).toBe(true); // streaming state
  });

  it('isLoading flips to false on terminal state', () => {
    vi.stubGlobal('fetch', neverResolvingFetch());
    useWizardStore.getState().setHost((p) => ({
      ...p,
      generation: { state: 'attached', jobId: 'job-1' },
    }));
    const { result } = renderHook(() => useHostGeneration());
    // Mount fires useEffect → subscribeToJob → beginLoading sets
    // isLoading=true. Now land a terminal-state snapshot via act() so
    // React flushes the zustand re-render.
    act(() => {
      useJobCacheStore.getState().setSnapshot('job-1', makeJobSnapshot({
        state: 'ready',
        batch_id: 'b1',
      }), 0);
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.batchId).toBe('b1');
  });

  it('surfaces snap.error when state=failed', () => {
    vi.stubGlobal('fetch', neverResolvingFetch());
    useWizardStore.getState().setHost((p) => ({
      ...p,
      generation: { state: 'attached', jobId: 'job-1' },
    }));
    const { result } = renderHook(() => useHostGeneration());
    act(() => {
      useJobCacheStore.getState().setSnapshot('job-1', makeJobSnapshot({
        state: 'failed',
        error: 'GPU OOM',
      }), 0);
    });
    expect(result.current.error).toBe('GPU OOM');
  });

  it('builds prevSelected from snap.prev_selected_image_id (server-provided)', () => {
    vi.stubGlobal('fetch', neverResolvingFetch());
    useWizardStore.getState().setHost((p) => ({
      ...p,
      generation: { state: 'attached', jobId: 'job-1' },
    }));
    const { result } = renderHook(() => useHostGeneration());
    act(() => {
      useJobCacheStore.getState().setSnapshot('job-1', makeJobSnapshot({
        state: 'ready',
        prev_selected_image_id: 'old-img',
      }), 0);
    });
    expect(result.current.prevSelected?.imageId).toBe('old-img');
    expect(result.current.prevSelected?.isPrev).toBe(true);
  });

  it('falls back to host.selected as prevSelected when snap has no server prev (step 18 gate)', () => {
    vi.stubGlobal('fetch', neverResolvingFetch());
    useWizardStore.getState().setHost((p) => ({
      ...p,
      generation: { state: 'attached', jobId: 'job-1' },
      selected: { imageId: 'user-pick', path: '/p/u.png', url: '/u/u.png', seed: 99 },
    }));
    const { result } = renderHook(() => useHostGeneration());
    act(() => {
      useJobCacheStore.getState().setSnapshot('job-1', makeJobSnapshot({
        state: 'streaming',
        prev_selected_image_id: null,
        variants: [{ image_id: 'new-1', path: '/p/n.png', url: '/u/n.png', seed: 1 }],
      }), 0);
    });
    expect(result.current.prevSelected?.imageId).toBe('user-pick');
    expect(result.current.prevSelected?.isPrev).toBe(true);
  });

  it('suppresses host.selected fallback when current batch already contains it', () => {
    // The user's pick is in the new batch's variants — it's the current
    // pick, NOT a "previous" tile. Prev should be null to avoid double-show.
    vi.stubGlobal('fetch', neverResolvingFetch());
    useWizardStore.getState().setHost((p) => ({
      ...p,
      generation: { state: 'attached', jobId: 'job-1' },
      selected: { imageId: 'shared', path: '/p/s.png', url: '/u/s.png', seed: 5 },
    }));
    const { result } = renderHook(() => useHostGeneration());
    act(() => {
      useJobCacheStore.getState().setSnapshot('job-1', makeJobSnapshot({
        state: 'streaming',
        prev_selected_image_id: null,
        variants: [{ image_id: 'shared', path: '/p/s.png', url: '/u/s.png', seed: 5 }],
      }), 0);
    });
    expect(result.current.prevSelected).toBeNull();
  });
});

describe('useHostGeneration — regenerate + abort', () => {
  it('regenerate POSTs /api/jobs and writes attached(jobId) to host.generation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'fresh-job', state: 'pending' }),
      })
      .mockImplementation(() => new Promise(() => { /* SSE hangs */ }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useHostGeneration());
    await act(async () => {
      await result.current.regenerate({ mode: 'v1', prompt: 'x' } as never);
    });

    const host = useWizardStore.getState().host;
    expect(host.generation.state).toBe('attached');
    if (host.generation.state === 'attached') {
      expect(host.generation.jobId).toBe('fresh-job');
    }
    // Selected is preserved across regenerate (step 18 fix).
    // (Initial selected is null in this test; just confirm setter didn't blow it away.)
    expect(host.selected).toBeNull();
  });

  it('regenerate failure surfaces as error and leaves generation unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ detail: 'server crashed' }),
      text: async () => '',
      url: 'http://test/api/jobs',
    }));

    const { result } = renderHook(() => useHostGeneration());
    await act(async () => {
      await result.current.regenerate({ mode: 'v1', prompt: 'x' } as never);
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(useWizardStore.getState().host.generation.state).toBe('idle');
  });

  it('abort calls DELETE on the active jobId', async () => {
    const deleteCalls: string[] = [];
    const fetchMock = vi.fn().mockImplementation(
      (url: string, init: RequestInit) => {
        if (init.method === 'DELETE') {
          deleteCalls.push(url);
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ id: 'job-1', state: 'cancelled' }),
          });
        }
        return new Promise(() => { /* SSE hangs */ });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    useWizardStore.getState().setHost((p) => ({
      ...p,
      generation: { state: 'attached', jobId: 'job-1' },
    }));
    const { result } = renderHook(() => useHostGeneration());
    act(() => result.current.abort());
    await waitFor(() => expect(deleteCalls.length).toBe(1));
    expect(deleteCalls[0]).toContain('/api/jobs/job-1');
  });

  it('abort silently swallows 404 (already-gone)', async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) => {
        if (init.method === 'DELETE') {
          return Promise.resolve({
            ok: false,
            status: 404,
            json: async () => ({ detail: 'gone' }),
            text: async () => '',
            url: 'http://test',
          });
        }
        return new Promise(() => { /* SSE hangs */ });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    useWizardStore.getState().setHost((p) => ({
      ...p,
      generation: { state: 'attached', jobId: 'job-1' },
    }));
    const { result } = renderHook(() => useHostGeneration());
    act(() => result.current.abort());
    // No error surfaced — 404 is swallowed.
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.error).toBeNull();
  });

  it('abort silently swallows 409 (already-terminal)', async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) => {
        if (init.method === 'DELETE') {
          return Promise.resolve({
            ok: false,
            status: 409,
            json: async () => ({ detail: 'already' }),
            text: async () => '',
            url: 'http://test',
          });
        }
        return new Promise(() => { /* SSE hangs */ });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    useWizardStore.getState().setHost((p) => ({
      ...p,
      generation: { state: 'attached', jobId: 'job-1' },
    }));
    const { result } = renderHook(() => useHostGeneration());
    act(() => result.current.abort());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.error).toBeNull();
  });
});
