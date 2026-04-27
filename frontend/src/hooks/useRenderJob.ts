/**
 * useRenderJob — single hook that owns "everything about an
 * in-flight or completed render from the UI's perspective."
 *
 * Combines two sources:
 *   1. `useQueueEntry(taskId)` — the 4s-polled queue row (status,
 *      timestamps, label, backend-side metadata).
 *   2. `subscribeProgress(taskId, …)` — the 1.5s-polled live
 *      progress snapshot (stage, progress, message).
 *
 * Pre-refactor, RenderDashboard maintained two parallel state
 * machines that read the same thing from two different sources and
 * tried to reconcile. This hook replaces both with a single
 * derived view. Phase 4 rebuilds RenderDashboard as a thin UI
 * over this hook.
 *
 * `elapsedMs` is a ticking display — 1s interval while the task is
 * running. Stops as soon as the task terminates (done/error/null).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { QueueEntry, TaskStateSnapshot } from '../types/app';
import { useTaskProgress } from '../api/queries/use-task-progress';
import { useQueue, useQueueEntry } from '../stores/queueStore';

export interface UseRenderJobReturn {
  /** Queue row (from the shared queue poll). Null until the snapshot
   * lands or if the id doesn't exist anywhere. */
  entry: QueueEntry | null;
  /** 0..1 progress from the live progress subscription. */
  progress: number | null;
  /** Current stage key (e.g. "generating", "complete"). */
  stage: TaskStateSnapshot['stage'] | null;
  /** Human-readable Korean status text the worker emits. */
  message: string | null;
  /** Elapsed ms since the task started. Ticks every 1s while
   * running; freezes on terminal. Null when we don't know the
   * start time yet. */
  elapsedMs: number | null;
  isDone: boolean;
  isError: boolean;
  /** True while we're still actively polling (task hasn't reached
   * a terminal stage and the queue still shows it as running/
   * pending). */
  isLive: boolean;
  /** If the poll gave up after repeated failures — surface so the
   * UI can show a reconnect hint. */
  pollFailed: boolean;
}

export function useRenderJob(taskId: string | null | undefined): UseRenderJobReturn {
  const entry = useQueueEntry(taskId ?? null);
  // `data` flips from null → snapshot once the queue poll fires its
  // first response. Used below to defer the progress subscription
  // until we've had a chance to see whether the task is already
  // terminal (attach-to-completed-task should skip the subscribe
  // entirely, not subscribe-then-immediately-unsubscribe).
  const { data: queueSnapshot } = useQueue();
  // Derive a stable boolean from the snapshot reference: once the
  // first poll lands, `data` stays non-null forever, so this flips
  // from false → true exactly once. Depending on `queueSnapshot`
  // directly in the effect below would re-fire every 4s (queueStore
  // writes a fresh object on every poll), causing subscribeProgress
  // to tear down + recreate on every tick — extra HTTP traffic and
  // a reset of the 12s error-give-up budget inside progress.ts.
  const queueSnapshotReady = queueSnapshot !== null;

  // Short-circuit: if the queue snapshot already shows the task is in
  // a terminal state (completed / error / cancelled), don't poll —
  // the only data progress would surface is already known from the
  // queue row, and attached users browsing old tasks would otherwise
  // fire a needless 1.5s poll that 404s against task_states.
  const entryStatus = entry?.status;
  const entryIsTerminal =
    entryStatus === 'completed' || entryStatus === 'error' || entryStatus === 'cancelled';

  // Lane E: TanStack Query owns the polling lifecycle now. The
  // `enabled` flag gates the entire query, so we never subscribe
  // until the queue snapshot lands AND the task is actually live.
  // TQ retries transient 5xx (3 attempts, exponential backoff) per
  // the global queryClient config; `failureCount >= 3` flips the
  // hook into an error state we surface as `pollFailed` to keep the
  // existing UI contract.
  const taskProgressQuery = useTaskProgress(taskId, {
    enabled: Boolean(taskId) && queueSnapshotReady && !entryIsTerminal,
  });

  const stage: TaskStateSnapshot['stage'] | null = taskProgressQuery.data?.stage ?? null;
  const progress: number | null =
    typeof taskProgressQuery.data?.progress === 'number'
      ? taskProgressQuery.data.progress
      : null;
  const message: string | null = taskProgressQuery.data?.message ?? null;
  const pollFailed = taskProgressQuery.failureCount >= 3 && taskProgressQuery.isError;

  // Elapsed ticker — 1s interval ONLY while the task is live.
  // Source-of-truth start time is `entry.started_at` (backend
  // timestamp); if that's not available yet (task still pending),
  // elapsed stays null instead of jumping the moment we pick a
  // fallback.
  const startedAt = entry?.started_at ?? null;
  const isTerminalStage = stage === 'complete' || stage === 'error';
  const isTerminalStatus = entry?.status === 'completed' || entry?.status === 'error' || entry?.status === 'cancelled';
  const isTerminal = isTerminalStage || isTerminalStatus;

  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  // Latch the terminal elapsed so it doesn't drift on later ticks.
  const frozenElapsedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!startedAt) {
      setElapsedMs(null);
      frozenElapsedRef.current = null;
      return;
    }
    const startMs = Date.parse(startedAt);
    if (Number.isNaN(startMs)) {
      setElapsedMs(null);
      return;
    }

    if (isTerminal) {
      // Freeze at the completion time if we have it; otherwise now.
      const endIso = entry?.completed_at;
      const endMs = endIso ? Date.parse(endIso) : Date.now();
      const frozen = Math.max(0, (Number.isFinite(endMs) ? endMs : Date.now()) - startMs);
      frozenElapsedRef.current = frozen;
      setElapsedMs(frozen);
      return;
    }

    setElapsedMs(Math.max(0, Date.now() - startMs));
    const t = setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startMs));
    }, 1000);
    return () => clearInterval(t);
  }, [startedAt, isTerminal, entry?.completed_at]);

  const isDone = isTerminalStage ? stage === 'complete' : entry?.status === 'completed';
  // `pollFailed` flips when subscribeProgress gives up after ~12s of
  // backend errors. Before this was folded in, pollFailed set a flag
  // nobody read — RenderDashboard's status aggregator only looks at
  // `isError`, so a dying progress endpoint surfaced as an eternal
  // spinner instead of a "뭔가 잘못됐어요" shell with the reconnect
  // message already staged in `errorMessage`.
  const isError =
    stage === 'error' ||
    entry?.status === 'error' ||
    entry?.status === 'cancelled' ||
    pollFailed;

  const isLive = useMemo(() => {
    if (!taskId) return false;
    if (isTerminal) return false;
    // No entry AND no progress yet = probably still resolving —
    // treat as live so the UI shows a spinner rather than
    // "disconnected".
    return true;
  }, [taskId, isTerminal]);

  return {
    entry,
    progress,
    stage,
    message,
    elapsedMs,
    isDone: Boolean(isDone),
    isError: Boolean(isError),
    isLive,
    pollFailed,
  };
}
