/**
 * queueStore — single shared poller for /api/queue, owned outside the
 * React tree.
 *
 * Replaces QueueContext.jsx. Why:
 *  - `useSyncExternalStore` (Zustand uses it internally) gives tear-
 *    free reads; React 18 concurrent renders can't see inconsistent
 *    snapshots.
 *  - Selector-based subscriptions — a component that only reads
 *    `total_pending` doesn't rerender on an unrelated `recent[]`
 *    change.
 *  - Poll lifecycle reference-counts subscribers across two tiers:
 *      · `active`     — popover open, in-flight render watcher, step
 *                       nav gate. Fast (4 s).
 *      · `background` — header badge only. Slow (30 s).
 *    When no subscribers exist, no network traffic. When the tab is
 *    hidden (Page Visibility API), the timer is suspended and the
 *    in-flight fetch is aborted. On `visibilitychange:visible` we
 *    immediately re-poll so the dot doesn't lie for up to 30 s after
 *    refocus.
 *
 *  - Diff-on-fetch: skip `set({data})` if the snapshot signature
 *    matches the previous one. Prevents Zustand from re-broadcasting
 *    a fresh `data` reference every tick when nothing actually
 *    changed (the poll snapshot object identity changes on every
 *    response, which would re-render every selector consumer).
 *
 * Hook surface mirrors the old QueueContext exactly — useQueue,
 * useQueueEntry, useQueuePosition.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import type { QueueEntry, QueueSnapshot } from '../types/app';
import { fetchQueue } from '../api/queue';

/** Polling tier — caller-declared intent. Active wins. */
export type PollTier = 'active' | 'background';

const ACTIVE_INTERVAL_MS = 4000;
const BACKGROUND_INTERVAL_MS = 30000;

// Circuit breaker: exponential backoff on consecutive failures so a
// 5-min backend outage doesn't fire 75 requests in the meantime.
const BACKOFF_STEPS_MS = [4000, 8000, 16000, 32000, 60000];

interface QueueState {
  data: QueueSnapshot | null;
  error: string | null;
  lastFetchedAt: number | null;
  set: (patch: Partial<QueueState>) => void;
}

const useQueueStoreRaw = create<QueueState>((set) => ({
  data: null,
  error: null,
  lastFetchedAt: null,
  set: (patch) => set(patch),
}));

// ────────────────────────────────────────────────────────────────────
// Tier-aware polling lifecycle
// ────────────────────────────────────────────────────────────────────

const counts = { active: 0, background: 0 };
let visible = typeof document !== 'undefined' ? !document.hidden : true;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let currentController: AbortController | null = null;
let consecutiveFailures = 0;
let visibilityListenerRegistered = false;

/** What interval should the timer fire at right now, given current demand?
 * Returns null when polling should not run at all (no subscribers OR
 * tab hidden OR backoff exhausted). */
function effectiveInterval(): number | null {
  if (!visible) return null;
  if (counts.active === 0 && counts.background === 0) return null;
  const baseline = counts.active > 0 ? ACTIVE_INTERVAL_MS : BACKGROUND_INTERVAL_MS;
  if (consecutiveFailures > 0) {
    const idx = Math.min(consecutiveFailures - 1, BACKOFF_STEPS_MS.length - 1);
    const backoff = BACKOFF_STEPS_MS[idx] ?? BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1] ?? baseline;
    // Backoff must SLOW polling, never speed it up — `max(baseline, backoff)`
    // protects the background tier (30 s) from getting accidentally
    // promoted to 4 s on the first failure.
    return Math.max(baseline, backoff);
  }
  return baseline;
}

/** Stable signature for diff-on-fetch. Two snapshots that produce the
 * same signature won't trigger a `set({data})` write — downstream
 * Zustand selectors only re-broadcast when this changes. */
function snapshotSignature(s: QueueSnapshot | null): string {
  if (!s) return 'null';
  const lists: QueueEntry[][] = [s.running || [], s.pending || [], s.recent || []];
  const parts: string[] = [`r${s.total_running ?? 0}`, `p${s.total_pending ?? 0}`];
  for (const list of lists) {
    parts.push(list.map((t) => `${t.task_id}:${t.status}:${t.progress ?? ''}`).join('|'));
  }
  return parts.join('#');
}

async function pollOnce(): Promise<void> {
  if (currentController) currentController.abort();
  const controller = new AbortController();
  currentController = controller;
  try {
    const next = await fetchQueue({ signal: controller.signal });
    if (currentController !== controller) return;
    consecutiveFailures = 0;
    const prev = useQueueStoreRaw.getState().data;
    if (snapshotSignature(prev) === snapshotSignature(next)) {
      // Same shape — only update timestamp + clear stale error, don't
      // touch `data` reference (avoids cascade re-renders).
      useQueueStoreRaw.getState().set({ error: null, lastFetchedAt: Date.now() });
      return;
    }
    useQueueStoreRaw.getState().set({ data: next, error: null, lastFetchedAt: Date.now() });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return;
    if (currentController !== controller) return;
    consecutiveFailures += 1;
    const message = err instanceof Error ? err.message : String(err);
    useQueueStoreRaw.getState().set({ error: message || '작업 목록 조회 실패' });
  }
}

/** While an immediate-poll cycle is in flight, dedupe further
 * `reschedule(true)` calls — two promotions in the same tick (e.g.
 * background subscriber mounted, then active subscriber mounted in
 * the same render) would otherwise both fire `pollOnce`, double-
 * counting against the spy mock and double-arming the next timer. */
let pendingImmediate: Promise<void> | null = null;

/** Clear the pending timer and re-arm with the current effective
 * interval. If `pollNow` is true and the new effective interval is
 * non-null, fire `pollOnce()` immediately before scheduling the next
 * tick — used on tier promotion (background→active) and on
 * visibility resume so the user doesn't wait a full slow tick. */
function reschedule(pollNow: boolean): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  const interval = effectiveInterval();
  if (interval == null) return;
  if (pollNow) {
    if (pendingImmediate) return;
    pendingImmediate = (async () => {
      try {
        await pollOnce();
      } finally {
        pendingImmediate = null;
      }
      // After the immediate poll the interval may have shifted (e.g.
      // failures incremented). Recompute and arm only if no other
      // call already armed it.
      if (pollTimer) return;
      const nextInterval = effectiveInterval();
      if (nextInterval != null) {
        pollTimer = setTimeout(loopTick, nextInterval);
      }
    })();
    return;
  }
  pollTimer = setTimeout(loopTick, interval);
}

async function loopTick(): Promise<void> {
  pollTimer = null;
  if (effectiveInterval() == null) return;
  await pollOnce();
  const next = effectiveInterval();
  if (next != null) {
    pollTimer = setTimeout(loopTick, next);
  }
}

function startPolling(tier: PollTier): void {
  // Tier promotion: bg→active when the only existing subs were background
  // and we just added our first active. Same trigger when going from
  // zero subs to any sub. Either way, kick a fresh poll right now so
  // the consumer gets fresh state on mount.
  const wasIdle = counts.active === 0 && counts.background === 0;
  const wasBackgroundOnly = counts.active === 0 && counts.background > 0;
  counts[tier] += 1;
  const promoted = wasIdle || (tier === 'active' && wasBackgroundOnly);
  if (promoted) {
    if (!visibilityListenerRegistered && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
      visibilityListenerRegistered = true;
    }
    reschedule(true);
  }
  // Demoted-to-equal cases (e.g. adding a background while active is
  // already counting) need no reschedule — the active interval still wins.
}

function stopPolling(tier: PollTier): void {
  counts[tier] = Math.max(0, counts[tier] - 1);
  if (counts.active === 0 && counts.background === 0) {
    // No subs left — abort and clear timer. (Visibility listener stays;
    // re-registering on every promotion would race with React strict
    // mode's double-invoke.)
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (currentController) {
      currentController.abort();
      currentController = null;
    }
    return;
  }
  // Tier downgrade (active→background-only) keeps any in-flight fetch —
  // a full snapshot in flight is still useful to the background sub.
  // Just reschedule so the next tick fires at the slower interval.
  reschedule(false);
}

function handleVisibilityChange(): void {
  const next = !document.hidden;
  if (next === visible) return;
  visible = next;
  if (visible) {
    // Returning from hidden — fire a fresh poll so the dot updates
    // before the user's eye lands on it (humans notice ~100 ms).
    reschedule(true);
  } else {
    // Going hidden — abort in-flight fetch (its result would land
    // into a tab the user isn't looking at), clear timer.
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (currentController) {
      currentController.abort();
      currentController = null;
    }
  }
}

/** Manual refresh — used right after enqueueing a task so the UI
 * doesn't wait up to one interval before showing the new row.
 * Fire-and-forget at call sites; returned promise is for tests. */
export function refreshQueue(): Promise<void> {
  return pollOnce();
}

/** Enroll a component as a queue subscriber at the given tier, or
 * pass `null` to opt out (useful for caller-conditional subscriptions
 * that can't put the hook behind an `if`). The tier choice is the
 * caller's declaration of how time-sensitive their read is — `active`
 * (4 s) for live render watchers, popover open, step nav gates;
 * `background` (30 s) for the header badge dot. */
export function usePolling(tier: PollTier | null = 'background'): void {
  useEffect(() => {
    if (tier == null) return undefined;
    startPolling(tier);
    return () => stopPolling(tier);
  }, [tier]);
}

// ────────────────────────────────────────────────────────────────────
// Public hook API — same signatures as the old QueueContext
// ────────────────────────────────────────────────────────────────────

export interface UseQueueReturn {
  data: QueueSnapshot | null;
  error: string | null;
  refresh: () => Promise<void>;
}

/** Background-tier subscription. The header badge reads via this hook
 * — slow polling is fine because the dot only encodes presence/absence,
 * not freshness-by-the-second. Components that need fast updates
 * (popover panel, render watcher) should also call
 * `usePolling('active')` for the duration of their fast-need state. */
export function useQueue(): UseQueueReturn {
  usePolling('background');
  const data = useQueueStoreRaw((s) => s.data);
  const error = useQueueStoreRaw((s) => s.error);
  return { data, error, refresh: refreshQueue };
}

/**
 * Queue position for a given task_id from the latest snapshot.
 *   0      → currently running
 *   N (≥1) → Nth in pending queue (1-indexed)
 *   null   → not in queue (finished, never enqueued, snapshot not loaded)
 *
 * Active tier: callers gate step navigation on this — stale-by-30s
 * would let the user step past a still-running task.
 */
export function useQueuePosition(taskId: string | null | undefined): number | null {
  usePolling('active');
  return useQueueStoreRaw((s) => {
    const d = s.data;
    if (!taskId || !d) return null;
    const runningIdx = (d.running || []).findIndex((t) => t.task_id === taskId);
    if (runningIdx >= 0) return 0;
    const pendingIdx = (d.pending || []).findIndex((t) => t.task_id === taskId);
    if (pendingIdx >= 0) return pendingIdx + 1;
    return null;
  });
}

/**
 * Full queue entry for a given task_id — searches running, pending,
 * and recent. Returns null if the snapshot hasn't landed or the task
 * isn't present.
 *
 * Active tier: drives `useRenderJob` which renders live progress on
 * the render page. Stale-by-30s would block the auto-redirect to
 * `/result/:taskId` on completion.
 */
export function useQueueEntry(taskId: string | null | undefined): QueueEntry | null {
  usePolling('active');
  return useQueueStoreRaw((s) => {
    const d = s.data;
    if (!taskId || !d) return null;
    const lists = [d.running || [], d.pending || [], d.recent || []];
    for (const list of lists) {
      const found = list.find((t) => t.task_id === taskId);
      if (found) return found;
    }
    return null;
  });
}

// ────────────────────────────────────────────────────────────────────
// Test / debug helpers — not part of the public surface, but exported
// so test files can deterministically drive the store.
// ────────────────────────────────────────────────────────────────────

export const __queueStoreInternals = {
  counts: () => ({ ...counts }),
  visible: () => visible,
  consecutiveFailures: () => consecutiveFailures,
  effectiveInterval,
  reset: () => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (currentController) {
      currentController.abort();
      currentController = null;
    }
    counts.active = 0;
    counts.background = 0;
    consecutiveFailures = 0;
    pendingImmediate = null;
    visible = typeof document !== 'undefined' ? !document.hidden : true;
    useQueueStoreRaw.setState({ data: null, error: null, lastFetchedAt: null });
  },
  setData: (data: QueueSnapshot | null) => useQueueStoreRaw.setState({ data }),
  setVisible: (next: boolean) => {
    if (next === visible) return;
    visible = next;
    if (visible) reschedule(true);
    else {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (currentController) {
        currentController.abort();
        currentController = null;
      }
    }
  },
  subscribe: useQueueStoreRaw.subscribe,
};
