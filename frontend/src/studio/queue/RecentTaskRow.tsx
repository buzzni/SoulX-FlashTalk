/**
 * RecentTaskRow — one recent (completed/error/cancelled) task.
 *
 * Completed rows are clickable (navigate to /result/:taskId).
 * Error/cancelled rows render the same layout but as a static <div> —
 * there's no result video to show, so the visual affordance of "click
 * me" would be a lie.
 */
import type { QueueEntry } from '../../types/app';
import { formatTaskTitle } from '../taskFormat.js';
import { statusLabel } from './queueFormat';
import { ROW_BASE_CLASS, ROW_BUTTON_CLASS } from './styles';
import { cn } from '@/lib/utils';

export interface RecentTaskRowProps {
  task: QueueEntry;
  onOpen: (taskId: string, status: string) => void;
}

export function RecentTaskRow({ task, onOpen }: RecentTaskRowProps) {
  const canOpen = task.status === 'completed';

  const body = (
    <>
      <div className="min-w-0 overflow-hidden">
        <div className="font-medium truncate">{formatTaskTitle(task.task_id, task.type)}</div>
        {task.label && <div className="text-[10px] text-ink-3 truncate">{task.label}</div>}
      </div>
      <div
        className={cn(
          'text-right text-[10px]',
          task.status === 'error' ? 'text-destructive' : 'text-ink-3',
        )}
      >
        {statusLabel(task.status)}
      </div>
    </>
  );

  if (canOpen) {
    return (
      <button
        type="button"
        onClick={() => onOpen(task.task_id, task.status)}
        className={ROW_BUTTON_CLASS}
        title="결과 영상 보기"
      >
        {body}
      </button>
    );
  }

  return <div className={ROW_BASE_CLASS}>{body}</div>;
}
