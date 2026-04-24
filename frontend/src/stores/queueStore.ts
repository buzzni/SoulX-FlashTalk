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
 *  - Poll lifecycle reference-counts subscribers: no subscribers →
 *    no network traffic. Replaces the "provider mounted forever"
 *    pattern that polled even when no consumer cared.
 *
 * Hook surface mirrors the old QueueContext exactly — useQueue,
 * useQueueEntry, useQueuePosition — so consumers don't change their
 * imports beyond `QueueContext.jsx` → `stores/queueStore`.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import type { QueueEntry, QueueSnapshot } from '../types/app';
import { fetchQueue } from '../api/queue';

const POLL_MS = 4000;

interface QueueState {
  data: QueueSnapshot | null;
  error: string | null;
  lastFetchedAt: number | null;
  set: (patch: Partial<QueueState>) => void;
}

// Internal Zustand store. Hooks below wrap it so consumers never
// touch the raw store.
const useQueueStoreRaw = create<QueueState>((set) => ({
  data: null,
  error: null,
  lastFetchedAt: null,
  set: (patch) => set(patch),
}));

// ────────────────────────────────────────────────────────────────────
// Refcount-gated polling lifecycle
// ────────────────────────────────────────────────────────────────────

let subscriberCount = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let currentController: AbortController | null = null;

async function pollOnce(): Promise<void> {
  if (currentController) currentController.abort();
  const controller = new AbortController();
  currentController = controller;
  try {
    const d = await fetchQueue({ signal: controller.signal });
    // Guard against late responses arriving after a newer poll kicked
    // off — only the freshest controller owns the state write.
    if (currentController !== controller) return;
    useQueueStoreRaw.getState().set({ data: d, error: null, lastFetchedAt: Date.now() });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return;
    if (currentController !== controller) return;
    const message = err instanceof Error ? err.message : String(err);
    useQueueStoreRaw.getState().set({ error: message || '작업 목록 조회 실패' });
  }
}

function scheduleNextPoll(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (subscriberCount <= 0) return;
    await pollOnce();
    if (subscriberCount > 0) scheduleNextPoll();
  }, POLL_MS);
}

function startPolling(): void {
  subscriberCount += 1;
  if (subscriberCount === 1) {
    // First subscriber — kick a poll immediately, then loop.
    void (async () => {
      await pollOnce();
      if (subscriberCount > 0) scheduleNextPoll();
    })();
  }
}

function stopPolling(): void {
  subscriberCount = Math.max(0, subscriberCount - 1);
  if (subscriberCount === 0) {
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

// Manual refresh — used right after enqueueing a new task so the UI
// doesn't wait up to POLL_MS before showing the new row. Returns the
// promise so callers can await if needed.
export function refreshQueue(): Promise<void> {
  return pollOnce();
}

/**
 * usePolling — mount/unmount hook that enrolls the component as a
 * queue subscriber. All queue-reading hooks below call this
 * internally; external consumers typically don't.
 */
function usePolling(): void {
  useEffect(() => {
    startPolling();
    return stopPolling;
  }, []);
}

// ────────────────────────────────────────────────────────────────────
// Public hook API — same signatures as the old QueueContext
// ────────────────────────────────────────────────────────────────────

export interface UseQueueReturn {
  data: QueueSnapshot | null;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useQueue(): UseQueueReturn {
  usePolling();
  const data = useQueueStoreRaw((s) => s.data);
  const error = useQueueStoreRaw((s) => s.error);
  return { data, error, refresh: refreshQueue };
}

/**
 * Queue position for a given task_id from the latest snapshot.
 *   0      → currently running
 *   N (≥1) → Nth in pending queue (1-indexed)
 *   null   → not in queue (finished, never enqueued, snapshot not loaded)
 */
export function useQueuePosition(taskId: string | null | undefined): number | null {
  usePolling();
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
 */
export function useQueueEntry(taskId: string | null | undefined): QueueEntry | null {
  usePolling();
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
// Test / debug helpers — not part of the public surface, but
// exported so test files can deterministically drive the store.
// ────────────────────────────────────────────────────────────────────

export const __queueStoreInternals = {
  subscriberCount: () => subscriberCount,
  reset: () => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (currentController) {
      currentController.abort();
      currentController = null;
    }
    subscriberCount = 0;
    useQueueStoreRaw.setState({ data: null, error: null, lastFetchedAt: null });
  },
  setData: (data: QueueSnapshot | null) => useQueueStoreRaw.setState({ data }),
  // Zustand subscribe — lets tests assert store semantics without
  // hitting the network.
  subscribe: useQueueStoreRaw.subscribe,
};
