/**
 * @vitest-environment jsdom
 *
 * Mirrors useHostGeneration tests with composite-specific differences:
 * no schemaSelected fallback for prevSelected (composition's prev is
 * server-only), and the regenerate path POSTs kind='composite'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCompositeGeneration } from '../useCompositeGeneration';
import { useJobCacheStore, type JobSnapshot } from '../../stores/jobCacheStore';
import { useWizardStore } from '../../stores/wizardStore';
import { _testReset } from '../../api/jobSubscription';
import { INITIAL_COMPOSITION } from '../../wizard/schema';

function neverResolvingFetch() {
  return vi.fn().mockImplementation(
    (_url: string, init: RequestInit) => {
      void init?.signal;
      return new Promise(() => { /* hang */ });
    },
  );
}

function makeSnap(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: 'job-c1',
    user_id: 'u1',
    kind: 'composite',
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
  useWizardStore.getState().setComposition(() => ({ ...INITIAL_COMPOSITION }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  _testReset();
});

describe('useCompositeGeneration — deriveReturn', () => {
  it('returns empty state when composition.generation is idle', () => {
    const { result } = renderHook(() => useCompositeGeneration());
    expect(result.current.variants).toEqual([]);
    expect(result.current.prevSelected).toBeNull();
    expect(result.current.batchId).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('projects variants from a cache snapshot', () => {
    vi.stubGlobal('fetch', neverResolvingFetch());
    useWizardStore.getState().setComposition((p) => ({
      ...p,
      generation: { state: 'attached', jobId: 'job-c1' },
    }));
    const { result } = renderHook(() => useCompositeGeneration());
    act(() => {
      useJobCacheStore.getState().setSnapshot('job-c1', makeSnap({
        state: 'streaming',
        variants: [
          { image_id: 'c1', path: '/p/c1.png', url: '/u/c1.png', seed: 1 },
        ],
      }), 0);
    });
    expect(result.current.variants).toHaveLength(1);
    expect(result.current.variants[0]?.imageId).toBe('c1');
  });

  it('isLoading flips to false on terminal state', () => {
    vi.stubGlobal('fetch', neverResolvingFetch());
    useWizardStore.getState().setComposition((p) => ({
      ...p,
      generation: { state: 'attached', jobId: 'job-c1' },
    }));
    const { result } = renderHook(() => useCompositeGeneration());
    act(() => {
      useJobCacheStore.getState().setSnapshot('job-c1', makeSnap({
        state: 'ready',
        batch_id: 'bc',
      }), 0);
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.batchId).toBe('bc');
  });

  it('builds prevSelected from snap.prev_selected_image_id (server-only, no schema fallback)', () => {
    vi.stubGlobal('fetch', neverResolvingFetch());
    useWizardStore.getState().setComposition((p) => ({
      ...p,
      generation: { state: 'attached', jobId: 'job-c1' },
    }));
    const { result } = renderHook(() => useCompositeGeneration());
    act(() => {
      useJobCacheStore.getState().setSnapshot('job-c1', makeSnap({
        state: 'ready',
        prev_selected_image_id: 'old',
      }), 0);
    });
    expect(result.current.prevSelected?.imageId).toBe('old');
  });

  it('does NOT fall back to composition.selected for prev tile (host-only behavior)', () => {
    // Unlike useHostGeneration which has a schemaSelected prev-tile
    // fallback (step 18), composition has no such fallback. Verify.
    vi.stubGlobal('fetch', neverResolvingFetch());
    useWizardStore.getState().setComposition((p) => ({
      ...p,
      generation: { state: 'attached', jobId: 'job-c1' },
      selected: { imageId: 'pick', path: '/p/p.png', url: '/u/p.png', seed: 9 },
    }));
    const { result } = renderHook(() => useCompositeGeneration());
    act(() => {
      useJobCacheStore.getState().setSnapshot('job-c1', makeSnap({
        state: 'streaming',
        prev_selected_image_id: null,
        variants: [],
      }), 0);
    });
    expect(result.current.prevSelected).toBeNull();
  });
});

describe('useCompositeGeneration — regenerate + abort', () => {
  it('regenerate POSTs /api/jobs (kind=composite) and clears selected', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchMock = vi.fn().mockImplementation(
      (url: string, init: RequestInit) => {
        if (init.method === 'POST') {
          calls.push({ url, body: JSON.parse(init.body as string) });
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ id: 'fresh-c', state: 'pending' }),
          });
        }
        return new Promise(() => { /* SSE hangs */ });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    // Pre-set selected so the regenerate-clears-selected behavior is
    // visible (composite differs from host here).
    useWizardStore.getState().setComposition((p) => ({
      ...p,
      selected: { imageId: 'old', path: '/p/o.png', url: '/u/o.png', seed: 1 },
    }));

    const { result } = renderHook(() => useCompositeGeneration());
    await act(async () => {
      await result.current.regenerate({
        hostImagePath: '/host.png',
        backgroundType: 'prompt',
      } as never);
    });

    const comp = useWizardStore.getState().composition;
    expect(comp.generation.state).toBe('attached');
    if (comp.generation.state === 'attached') {
      expect(comp.generation.jobId).toBe('fresh-c');
    }
    // Composite clears selected on regenerate (diverges from host).
    expect(comp.selected).toBeNull();
    expect(calls[0]?.body).toMatchObject({ kind: 'composite' });
  });

  it('abort 404 is silently swallowed', async () => {
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

    useWizardStore.getState().setComposition((p) => ({
      ...p,
      generation: { state: 'attached', jobId: 'job-c1' },
    }));
    const { result } = renderHook(() => useCompositeGeneration());
    act(() => result.current.abort());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.error).toBeNull();
  });

  it('regenerate failure surfaces error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ detail: 'boom' }),
      text: async () => '',
      url: 'http://test',
    }));
    const { result } = renderHook(() => useCompositeGeneration());
    await act(async () => {
      await result.current.regenerate({
        hostImagePath: '/x',
        backgroundType: 'prompt',
      } as never);
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());
  });
});
