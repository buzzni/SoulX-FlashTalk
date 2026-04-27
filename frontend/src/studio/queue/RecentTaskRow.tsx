/**
 * RecentTaskRow — one recent (completed/error/cancelled) task.
 *
 * Completed rows are clickable (navigate to /result/:taskId).
 * Error/cancelled rows can't navigate to a result video, but they
 * surface a "재시도" button when an onRetry handler is provided —
 * backend re-enqueues the same params under a new task_id.
 */
import type { QueueEntry } from '../../types/app';
import Icon from '../Icon.jsx';
import { formatTaskTitle } from '../taskFormat.js';
import { statusLabel } from './queueFormat';
import { ROW_BASE_CLASS, RECENT_BUTTON_CLASS } from './styles';
import { cn } from '@/lib/utils';

export interface RecentTaskRowProps {
  task: QueueEntry;
  onOpen: (taskId: string, status: string) => void;
  onRetry?: (taskId: string, label: string) => void;
  retrying?: boolean;
}

export function RecentTaskRow({
  task,
  onOpen,
  onRetry,
  retrying = false,
}: RecentTaskRowProps) {
  const canOpen = task.status === 'completed';
  const canRetry =
    !!onRetry && (task.status === 'error' || task.status === 'cancelled');

  const body = (
    <>
      <div className="min-w-0 overflow-hidden">
        <div className="font-medium truncate">{formatTaskTitle(task.task_id, task.type)}</div>
        {task.label && <div className="text-2xs text-ink-3 truncate">{task.label}</div>}
      </div>
      <div
        className={cn(
          'text-right text-2xs',
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
        className={RECENT_BUTTON_CLASS}
        title="결과 영상 보기"
      >
        {body}
      </button>
    );
  }

  if (canRetry) {
    // Two-element layout: static row body + retry affordance on the right.
    // The button is a separate <button> so the row itself stays a div
    // (no nested-button DOM warnings, no accidental click bubbling).
    return (
      <div className={cn(ROW_BASE_CLASS, 'group')}>
        {body}
        <button
          type="button"
          disabled={retrying}
          onClick={(e) => {
            e.stopPropagation();
            if (!retrying) onRetry!(task.task_id, task.label || '');
          }}
          className={cn(
            'ml-2 flex items-center gap-1 rounded-sm px-2 py-0.5 text-2xs',
            'border border-border-2 bg-surface-1 hover:bg-surface-2',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
          title="같은 입력으로 다시 시도"
          aria-label="재시도"
        >
          <Icon name="refresh" size={11} className={retrying ? 'animate-spin' : ''} />
          <span>{retrying ? '재시도 중…' : '재시도'}</span>
        </button>
      </div>
    );
  }

  return <div className={ROW_BASE_CLASS}>{body}</div>;
}
