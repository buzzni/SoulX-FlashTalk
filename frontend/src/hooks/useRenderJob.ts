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
import { subscribeProgress, type ProgressEvent } from '../api/progress';
import { useQueueEntry } from '../stores/queueStore';

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

  const [progress, setProgress] = useState<number | null>(null);
  const [stage, setStage] = useState<TaskStateSnapshot['stage'] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pollFailed, setPollFailed] = useState(false);

  // Progress subscription — one live connection per taskId. Clean
  // unsubscribe on taskId change or unmount (the subscribe helper
  // owns its own AbortController).
  useEffect(() => {
    if (!taskId) return;
    setPollFailed(false);
    const unsubscribe = subscribeProgress(taskId, (evt: ProgressEvent) => {
      // Discriminate on the `error` variant — the happy-path variant
      // carries stage/progress/message, the error variant is a flat
      // `{error: true}` sentinel.
      if ('error' in evt) {
        setPollFailed(true);
        return;
      }
      setStage(evt.stage ?? null);
      setProgress(typeof evt.progress === 'number' ? evt.progress : null);
      setMessage(evt.message ?? null);
    });
    return unsubscribe;
  }, [taskId]);

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
  const isError =
    stage === 'error' ||
    entry?.status === 'error' ||
    entry?.status === 'cancelled';

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
