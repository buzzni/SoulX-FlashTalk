/**
 * useQueueActions — cancel orchestration for the queue panel.
 *
 * Owns:
 *   - per-task "cancelling" flag so a spinner can swap in for the X icon
 *     without disabling the rest of the panel,
 *   - cancel error surfacing (last error, cleared on next attempt),
 *   - triggering a fresh queue snapshot via the store's refresh so the
 *     cancelled row drops out.
 *
 * Kept as a hook (not plain helpers) because the cancel flow reads/writes
 * local UI state (`cancellingIds`, `cancelError`) that the panel needs
 * to render immediately.
 */
import { useCallback, useState } from 'react';
import { cancelQueuedTask, retryFailedTask } from '../../api/queue';
import { humanizeError } from '../../api/http';

export interface UseQueueActions {
  cancellingIds: Set<string>;
  cancelError: string | null;
  cancel: (taskId: string, label: string) => Promise<void>;
  retryingIds: Set<string>;
  retryError: string | null;
  retry: (taskId: string, label: string) => Promise<string | null>;
}

export function useQueueActions(refresh: () => void): UseQueueActions {
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set());
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const [retryError, setRetryError] = useState<string | null>(null);

  const cancel = useCallback(
    async (taskId: string, label: string) => {
      if (!window.confirm(`이 작업을 취소할까요?\n${label || taskId}`)) return;
      setCancellingIds((prev) => {
        const next = new Set(prev);
        next.add(taskId);
        return next;
      });
      setCancelError(null);
      try {
        await cancelQueuedTask(taskId);
        refresh();
      } catch (err) {
        setCancelError(humanizeError(err));
      } finally {
        setCancellingIds((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }
    },
    [refresh],
  );

  // Retry returns the new task_id (caller can navigate to /render/:newId);
  // null on cancel or failure. Confirm + per-task spinner mirror cancel().
  const retry = useCallback(
    async (taskId: string, label: string): Promise<string | null> => {
      if (!window.confirm(`이 작업을 다시 시도할까요?\n${label || taskId}`)) {
        return null;
      }
      setRetryingIds((prev) => {
        const next = new Set(prev);
        next.add(taskId);
        return next;
      });
      setRetryError(null);
      try {
        const res = await retryFailedTask(taskId);
        refresh();
        return (res?.task_id as string | undefined) ?? null;
      } catch (err) {
        setRetryError(humanizeError(err));
        return null;
      } finally {
        setRetryingIds((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }
    },
    [refresh],
  );

  return {
    cancellingIds,
    cancelError,
    cancel,
    retryingIds,
    retryError,
    retry,
  };
}
