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
// Exponential-backoff cap. Same shape as `query-client.ts:22` so the
// codebase has one backoff convention. Schedule on consecutive
// failures: 1→4 s, 2→8 s, 3→16 s, 4→32 s, 5+→60 s clamped.
const BACKOFF_BASE_MS = ACTIVE_INTERVAL_MS;
const BACKOFF_CAP_MS = 60000;

interface QueueState {
  data: QueueSnapshot | null;
  error: string | null;
  set: (patch: Partial<QueueState>) => void;
}

const useQueueStoreRaw = create<QueueState>((set) => ({
  data: null,
  error: null,
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
// Cached signature of the current `data` value. Avoids recomputing
// the prev signature on every poll for the diff-on-fetch check.
let lastSignature = 'null';
// Single-flight gate for `pollNowAndArm()` — two promotions in the
// same render tick (e.g. background + active subscriber mounted
// together) won't double-poll.
let pendingImmediate: Promise<void> | null = null;

function effectiveInterval(): number | null {
  if (!visible) return null;
  if (counts.active === 0 && counts.background === 0) return null;
  const baseline = counts.active > 0 ? ACTIVE_INTERVAL_MS : BACKGROUND_INTERVAL_MS;
  if (consecutiveFailures > 0) {
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), BACKOFF_CAP_MS);
    // max(baseline, backoff) so a single failure can't accidentally
    // promote the 30 s background tier to 4 s.
    return Math.max(baseline, backoff);
  }
  return baseline;
}

function snapshotSignature(s: QueueSnapshot | null): string {
  if (!s) return 'null';
  const lists: QueueEntry[][] = [s.running || [], s.pending || [], s.recent || []];
  const parts: string[] = [`r${s.total_running ?? 0}`, `p${s.total_pending ?? 0}`];
  for (const list of lists) {
    parts.push(list.map((t) => `${t.task_id}:${t.status}:${t.progress ?? ''}`).join('|'));
  }
  return parts.join('#');
}

/** Cancel any pending timer and any in-flight fetch. Used when there
 * are no subscribers OR the tab goes hidden — both states mean we
 * don't want a response landing into a stale store. */
function suspendPolling(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (currentController) {
    currentController.abort();
    currentController = null;
  }
}

async function pollOnce(): Promise<void> {
  if (currentController) currentController.abort();
  const controller = new AbortController();
  currentController = controller;
  try {
    const next = await fetchQueue({ signal: controller.signal });
    if (currentController !== controller) return;
    consecutiveFailures = 0;
    const nextSig = snapshotSignature(next);
    if (nextSig === lastSignature) {
      // No-op write avoidance: only clear `error` if it was actually
      // set last poll. Otherwise the setState broadcast wakes every
      // selector even though nothing readable changed.
      if (useQueueStoreRaw.getState().error !== null) {
        useQueueStoreRaw.getState().set({ error: null });
      }
      return;
    }
    lastSignature = nextSig;
    useQueueStoreRaw.getState().set({ data: next, error: null });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return;
    if (currentController !== controller) return;
    consecutiveFailures += 1;
    const message = err instanceof Error ? err.message : String(err);
    useQueueStoreRaw.getState().set({ error: message || '작업 목록 조회 실패' });
  }
}

/** Arm the next loop tick at the current effective interval (no
 * immediate poll). Caller must clear any existing timer first. */
function armNextTick(): void {
  const interval = effectiveInterval();
  if (interval == null) return;
  pollTimer = setTimeout(loopTick, interval);
}

/** Fire `pollOnce()` immediately, then arm the next tick. Deduped
 * via `pendingImmediate` so concurrent promotions in the same render
 * pass don't multiply fetches. */
function pollNowAndArm(): void {
  if (pendingImmediate) return;
  pendingImmediate = (async () => {
    try {
      await pollOnce();
    } finally {
      pendingImmediate = null;
    }
    if (pollTimer) return;
    armNextTick();
  })();
}

async function loopTick(): Promise<void> {
  pollTimer = null;
  if (effectiveInterval() == null) return;
  await pollOnce();
  armNextTick();
}

function startPolling(tier: PollTier): void {
  // Tier promotion (idle→any-sub OR background-only→active) gets a
  // fresh poll right now so the consumer sees current state on mount.
  // No-promotion adds (e.g. second background subscriber while active
  // is already counting) just inherit the existing schedule.
  const wasIdle = counts.active === 0 && counts.background === 0;
  const wasBackgroundOnly = counts.active === 0 && counts.background > 0;
  counts[tier] += 1;
  const promoted = wasIdle || (tier === 'active' && wasBackgroundOnly);
  if (promoted) {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    pollNowAndArm();
  }
}

function stopPolling(tier: PollTier): void {
  counts[tier] = Math.max(0, counts[tier] - 1);
  if (counts.active === 0 && counts.background === 0) {
    suspendPolling();
    return;
  }
  // Tier downgrade (active→background-only) keeps any in-flight fetch —
  // a full snapshot in flight is still useful to the background sub.
  // Just reschedule so the next tick fires at the slower interval.
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  armNextTick();
}

function handleVisibilityChange(): void {
  const next = !document.hidden;
  if (next === visible) return;
  visible = next;
  if (visible) {
    // Returning from hidden — fire a fresh poll so the dot updates
    // before the user's eye lands on it (humans notice ~100 ms).
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    pollNowAndArm();
  } else {
    suspendPolling();
  }
}

if (typeof document !== 'undefined') {
  // Module-init listener — singleton lifetime equals the page; no
  // teardown needed. Lazy-registering only on first promotion would
  // race with React strict mode's double-invoke without buying anything.
  document.addEventListener('visibilitychange', handleVisibilityChange);
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
    suspendPolling();
    counts.active = 0;
    counts.background = 0;
    consecutiveFailures = 0;
    pendingImmediate = null;
    lastSignature = 'null';
    visible = typeof document !== 'undefined' ? !document.hidden : true;
    useQueueStoreRaw.setState({ data: null, error: null });
  },
  setData: (data: QueueSnapshot | null) => {
    lastSignature = snapshotSignature(data);
    useQueueStoreRaw.setState({ data });
  },
  setVisible: (next: boolean) => {
    if (next === visible) return;
    visible = next;
    if (visible) {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      pollNowAndArm();
    } else {
      suspendPolling();
    }
  },
  subscribe: useQueueStoreRaw.subscribe,
};
