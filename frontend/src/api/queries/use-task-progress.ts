/**
 * useTaskProgress — TanStack Query polling for /api/tasks/:id/state.
 *
 * Lane E replaces the manual `subscribeProgress` poller with TQ's
 * built-in `refetchInterval`. TQ v5's interval callback receives the
 * Query object (not the data); we read `query.state.data` to decide
 * whether to keep polling.
 *
 * D5 cherry-pick: while polling, we also overwrite `document.title`
 * with the live progress percent so multi-tab users can glance at the
 * tab bar to see "67% — 영상 생성 중". The previous title is captured
 * on subscription and restored on cleanup, so navigating away or
 * task completion never leaves a stale "n% — …" title behind.
 */

import { useEffect, useRef } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { fetchJSON } from '../http';
import { schemas } from '../schemas-generated';
import type { TaskStateSnapshot } from '../../types/app';

const POLL_MS = 1500;

async function fetchTaskState(taskId: string, signal?: AbortSignal): Promise<TaskStateSnapshot> {
  return (await fetchJSON(`/api/tasks/${encodeURIComponent(taskId)}/state`, {
    label: '작업 상태 조회',
    signal,
    cache: 'no-store',
    schema: schemas.TaskStateSnapshot,
  })) as TaskStateSnapshot;
}

export interface UseTaskProgressOptions {
  /** Disable polling without unmounting. Used when the queue row
   * already shows the task is terminal. */
  enabled?: boolean;
  /** When true, overwrites document.title with live progress while
   * polling. Defaults true; set false in tests / non-tab contexts. */
  writeTabTitle?: boolean;
}

export function useTaskProgress(
  taskId: string | null | undefined,
  { enabled = true, writeTabTitle = true }: UseTaskProgressOptions = {},
): UseQueryResult<TaskStateSnapshot, Error> {
  const result = useQuery({
    queryKey: ['task-state', taskId ?? null],
    queryFn: ({ signal }) => fetchTaskState(taskId as string, signal),
    enabled: enabled && Boolean(taskId),
    // TQ v5: refetchInterval receives the Query, NOT the data.
    refetchInterval: (query) => {
      const stage = query.state.data?.stage;
      if (stage === 'complete' || stage === 'error') return false;
      return POLL_MS;
    },
    // 5xx → caller decides what to surface; the global retry policy
    // already retries 5xx with exponential backoff up to 3 attempts.
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  // Tab title cherry-pick (D5 / C5).
  const previousTitleRef = useRef<string | null>(null);
  const stage = result.data?.stage ?? null;
  const progress = result.data?.progress ?? null;
  useEffect(() => {
    if (!writeTabTitle) return;
    if (typeof document === 'undefined') return;
    if (!enabled || !taskId) return;
    if (stage === 'complete' || stage === 'error') return;
    if (progress === null || progress === undefined) return;

    if (previousTitleRef.current === null) {
      previousTitleRef.current = document.title;
    }
    const pct = Math.max(0, Math.min(100, Math.round((progress as number) * 100)));
    document.title = `${pct}% — 영상 생성 중`;

    return () => {
      if (previousTitleRef.current !== null) {
        document.title = previousTitleRef.current;
        previousTitleRef.current = null;
      }
    };
  }, [stage, progress, enabled, taskId, writeTabTitle]);

  return result;
}
