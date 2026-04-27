/**
 * queueStore — tier polling + Page Visibility integration.
 *
 * Drives the store at the function level (start/stopPolling via the
 * useEffect-mounted helpers and __queueStoreInternals). Mocks
 * `fetchQueue` so the timer schedule, abort lifecycle, and snapshot
 * diff can be asserted without any real network.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { QueueSnapshot } from '../../types/app';

const fetchQueueMock = vi.fn<(opts: { signal?: AbortSignal }) => Promise<QueueSnapshot>>();

vi.mock('../../api/queue', () => ({
  fetchQueue: (opts: { signal?: AbortSignal }) => fetchQueueMock(opts),
}));

// Import AFTER vi.mock so the store grabs the mocked fetchQueue.
import {
  __queueStoreInternals,
  usePolling,
  refreshQueue,
} from '../queueStore';

const ACTIVE_INTERVAL_MS = 4000;
const BACKGROUND_INTERVAL_MS = 30000;

function makeSnapshot(overrides: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return {
    running: [],
    pending: [],
    recent: [],
    total_running: 0,
    total_pending: 0,
    ...overrides,
  } as QueueSnapshot;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchQueueMock.mockReset();
  fetchQueueMock.mockResolvedValue(makeSnapshot());
  __queueStoreInternals.reset();
});

afterEach(() => {
  __queueStoreInternals.reset();
  vi.useRealTimers();
});

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('queueStore — tier polling lifecycle', () => {
  it('background-only mount schedules at 30s and fires immediate poll', async () => {
    renderHook(() => usePolling('background'));
    await flushMicrotasks();

    // Promotion → immediate pollOnce
    expect(fetchQueueMock).toHaveBeenCalledTimes(1);
    expect(__queueStoreInternals.counts()).toEqual({ active: 0, background: 1 });
    expect(__queueStoreInternals.effectiveInterval()).toBe(BACKGROUND_INTERVAL_MS);

    // Next tick at 30s, not 4s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVE_INTERVAL_MS + 100);
    });
    expect(fetchQueueMock).toHaveBeenCalledTimes(1); // still 1 — not yet 30s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_INTERVAL_MS);
    });
    expect(fetchQueueMock).toHaveBeenCalledTimes(2);
  });

  it('active mount on top of background promotes interval to 4s and fires immediate poll', async () => {
    const bg = renderHook(() => usePolling('background'));
    await flushMicrotasks();
    expect(fetchQueueMock).toHaveBeenCalledTimes(1);

    // Add active subscriber — promotes effective interval, fires fresh poll.
    renderHook(() => usePolling('active'));
    await flushMicrotasks();
    expect(fetchQueueMock).toHaveBeenCalledTimes(2);
    expect(__queueStoreInternals.counts()).toEqual({ active: 1, background: 1 });
    expect(__queueStoreInternals.effectiveInterval()).toBe(ACTIVE_INTERVAL_MS);

    // Next tick at 4s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVE_INTERVAL_MS);
    });
    expect(fetchQueueMock).toHaveBeenCalledTimes(3);

    // Cleanup
    bg.unmount();
  });

  it('unmounting last active drops back to 30s WITHOUT aborting an in-flight fetch', async () => {
    let resolveFetch: ((s: QueueSnapshot) => void) | null = null;
    fetchQueueMock.mockImplementation(
      () =>
        new Promise<QueueSnapshot>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const bg = renderHook(() => usePolling('background'));
    const active = renderHook(() => usePolling('active'));
    await flushMicrotasks();
    // Two promotions but the latter aborts the former — net 1 in-flight + 1 promoted call after.
    // Either way, an in-flight fetch is sitting there waiting for resolveFetch.
    expect(__queueStoreInternals.counts()).toEqual({ active: 1, background: 1 });

    // Unmount active. Per plan: in-flight fetch is NOT aborted — its
    // result is still useful to the background subscriber.
    active.unmount();
    await flushMicrotasks();

    expect(__queueStoreInternals.counts()).toEqual({ active: 0, background: 1 });
    expect(__queueStoreInternals.effectiveInterval()).toBe(BACKGROUND_INTERVAL_MS);
    // The in-flight controller should still be alive — not aborted.
    expect(resolveFetch).not.toBeNull();
    // Resolve it cleanly to avoid leaking the promise.
    resolveFetch!(makeSnapshot());
    await flushMicrotasks();

    bg.unmount();
  });

  it('unmounting all subscribers aborts in-flight fetch and clears the timer', async () => {
    let abortSignal: AbortSignal | undefined;
    fetchQueueMock.mockImplementation((opts) => {
      abortSignal = opts.signal;
      return new Promise<QueueSnapshot>(() => {
        // never resolves on its own
      });
    });

    const sub = renderHook(() => usePolling('active'));
    await flushMicrotasks();
    expect(abortSignal?.aborted).toBe(false);

    sub.unmount();
    await flushMicrotasks();

    expect(abortSignal?.aborted).toBe(true);
    expect(__queueStoreInternals.counts()).toEqual({ active: 0, background: 0 });
    expect(__queueStoreInternals.effectiveInterval()).toBeNull();
  });

  it('hidden visibility suspends timer and aborts in-flight; visible resumes with immediate poll', async () => {
    let abortSignal: AbortSignal | undefined;
    fetchQueueMock.mockImplementation((opts) => {
      abortSignal = opts.signal;
      return Promise.resolve(makeSnapshot());
    });

    renderHook(() => usePolling('active'));
    await flushMicrotasks();
    expect(fetchQueueMock).toHaveBeenCalledTimes(1);

    // Tab hidden — kills timer, aborts in-flight (here already resolved
    // so abort is a no-op, but the signal is still aborted).
    act(() => {
      __queueStoreInternals.setVisible(false);
    });
    expect(abortSignal?.aborted).toBe(true);
    expect(__queueStoreInternals.effectiveInterval()).toBeNull();

    // Advance time — no new poll while hidden.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVE_INTERVAL_MS * 3);
    });
    expect(fetchQueueMock).toHaveBeenCalledTimes(1);

    // Tab visible again — fires fresh poll right away.
    fetchQueueMock.mockResolvedValue(makeSnapshot());
    act(() => {
      __queueStoreInternals.setVisible(true);
    });
    await flushMicrotasks();
    expect(fetchQueueMock).toHaveBeenCalledTimes(2);
  });

  it('snapshot with identical signature does not re-broadcast data reference', async () => {
    const initial = makeSnapshot({
      running: [{ task_id: 't1', status: 'running', progress: 0.5 } as never],
      total_running: 1,
    });
    const sameSig = makeSnapshot({
      running: [{ task_id: 't1', status: 'running', progress: 0.5 } as never],
      total_running: 1,
    });

    fetchQueueMock.mockResolvedValueOnce(initial);
    fetchQueueMock.mockResolvedValueOnce(sameSig);

    renderHook(() => usePolling('background'));
    await flushMicrotasks();
    expect(fetchQueueMock).toHaveBeenCalledTimes(1);

    // Subscribe BEFORE the second poll fires; count `data`-reference
    // changes only. Zustand calls listeners with (next, prev) on every
    // setState; if `pollOnce` decides the signature is unchanged it
    // shouldn't write a new `data` ref.
    let dataRefChanges = 0;
    const unsub = __queueStoreInternals.subscribe((s, prev) => {
      if (s.data !== prev.data) dataRefChanges += 1;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_INTERVAL_MS);
    });
    unsub();
    expect(fetchQueueMock).toHaveBeenCalledTimes(2);
    expect(dataRefChanges).toBe(0);
  });

  it('exponential backoff on consecutive failures, reset on success', async () => {
    fetchQueueMock.mockRejectedValue(new Error('network'));
    renderHook(() => usePolling('active'));
    await flushMicrotasks();
    expect(fetchQueueMock).toHaveBeenCalledTimes(1);
    expect(__queueStoreInternals.consecutiveFailures()).toBe(1);

    // After one failure at active tier, baseline is 4s and backoff[0]
    // is also 4s — interval stays at 4s (max(4000, 4000) = 4000).
    expect(__queueStoreInternals.effectiveInterval()).toBe(4000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetchQueueMock).toHaveBeenCalledTimes(2);
    expect(__queueStoreInternals.consecutiveFailures()).toBe(2);
    // Now interval should be max(4000, 8000) = 8000.
    expect(__queueStoreInternals.effectiveInterval()).toBe(8000);

    // Success — reset.
    fetchQueueMock.mockResolvedValueOnce(makeSnapshot());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(fetchQueueMock).toHaveBeenCalledTimes(3);
    expect(__queueStoreInternals.consecutiveFailures()).toBe(0);
    expect(__queueStoreInternals.effectiveInterval()).toBe(4000);
  });
});

describe('queueStore — adversarial-pass regressions', () => {
  it('visibility=visible without subscribers does NOT poll', async () => {
    // No usePolling mount; counts stay at zero. Hidden→visible
    // transitions must respect the "no subs, no traffic" invariant —
    // earlier `pollNowAndArm` fired regardless and could hit the
    // backend after logout / on routes with no queue consumer.
    act(() => {
      __queueStoreInternals.setVisible(false);
    });
    act(() => {
      __queueStoreInternals.setVisible(true);
    });
    await flushMicrotasks();
    expect(fetchQueueMock).not.toHaveBeenCalled();
    expect(__queueStoreInternals.counts()).toEqual({ active: 0, background: 0 });
  });

  it('suspendPolling clears pendingImmediate so the next promotion re-fires immediately', async () => {
    // Strict-mode-like sequence: mount → unmount → mount. The first
    // mount kicks off a pollOnce IIFE; unmount aborts the controller
    // and (regression: previously) left pendingImmediate non-null,
    // so the second mount's pollNowAndArm short-circuited and the
    // user got stale data for one full interval.
    let resolveFirst: ((s: QueueSnapshot) => void) | null = null;
    fetchQueueMock.mockImplementationOnce(
      () =>
        new Promise<QueueSnapshot>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    fetchQueueMock.mockResolvedValue(makeSnapshot());

    const first = renderHook(() => usePolling('active'));
    await flushMicrotasks();
    expect(fetchQueueMock).toHaveBeenCalledTimes(1);

    first.unmount();
    await flushMicrotasks();
    // First IIFE still pending — but suspendPolling cleared the gate.
    renderHook(() => usePolling('active'));
    await flushMicrotasks();
    expect(fetchQueueMock).toHaveBeenCalledTimes(2);

    // Drain the orphaned first promise so vitest doesn't warn.
    if (resolveFirst) (resolveFirst as (s: QueueSnapshot) => void)(makeSnapshot());
    await flushMicrotasks();
  });

  it('only one timer is armed across rapid tier-change churn (no ghost setTimeouts)', async () => {
    // Earlier `armNextTick` set pollTimer without clearing the
    // previous handle: a stopPolling-then-loopTick race could leak a
    // ghost timer that fired alongside the canonical one. After the
    // fix, single-timer invariant holds even after many transitions.
    const bg = renderHook(() => usePolling('background'));
    await flushMicrotasks();
    fetchQueueMock.mockClear();

    for (let i = 0; i < 5; i += 1) {
      const active = renderHook(() => usePolling('active'));
      await flushMicrotasks();
      active.unmount();
      await flushMicrotasks();
    }

    // Each promotion fires at most one immediate poll. With 5 cycles
    // we expect <= 5 fetches, not 10+ from racing timers.
    expect(fetchQueueMock.mock.calls.length).toBeLessThanOrEqual(5);

    // Advance one background interval and verify exactly one tick fires.
    fetchQueueMock.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_INTERVAL_MS);
    });
    expect(fetchQueueMock).toHaveBeenCalledTimes(1);

    bg.unmount();
  });
});

describe('queueStore — manual refresh', () => {
  it('refreshQueue() runs pollOnce ad-hoc independent of timer schedule', async () => {
    renderHook(() => usePolling('background'));
    await flushMicrotasks();
    expect(fetchQueueMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await refreshQueue();
    });
    expect(fetchQueueMock).toHaveBeenCalledTimes(2);
  });
});
