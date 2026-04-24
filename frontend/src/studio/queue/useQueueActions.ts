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
import { cancelQueuedTask } from '../../api/queue';
import { humanizeError } from '../../api/http';

export interface UseQueueActions {
  cancellingIds: Set<string>;
  cancelError: string | null;
  cancel: (taskId: string, label: string) => Promise<void>;
}

export function useQueueActions(refresh: () => void): UseQueueActions {
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set());
  const [cancelError, setCancelError] = useState<string | null>(null);

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

  return { cancellingIds, cancelError, cancel };
}
