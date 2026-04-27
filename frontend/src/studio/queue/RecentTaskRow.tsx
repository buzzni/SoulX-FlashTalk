/**
 * RecentTaskRow — one recent (completed/error/cancelled) task.
 *
 * All three statuses are clickable — error/cancelled rows route to the
 * same /result/:taskId page so users can read the failure reason, see
 * the params they used, and decide whether to retry. The retry button
 * lives inside the row but stops click propagation, so clicking the
 * label area opens the result while clicking the button retries.
 *
 * Outer element is a `div role="button"` (not `<button>`) because
 * nesting <button> inside <button> is invalid HTML and breaks the
 * retry control's keyboard semantics.
 */
import type { QueueEntry } from '../../types/app';
import Icon from '../Icon.jsx';
import { formatTaskTitle } from '../taskFormat.js';
import { statusLabel } from './queueFormat';
import { RECENT_BUTTON_CLASS } from './styles';
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
  const canRetry =
    !!onRetry && (task.status === 'error' || task.status === 'cancelled');

  const titleHint =
    task.status === 'completed' ? '결과 영상 보기' : '실패 작업 자세히 보기';

  const handleOpen = () => onOpen(task.task_id, task.status);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleOpen();
        }
      }}
      className={cn(RECENT_BUTTON_CLASS, 'cursor-pointer')}
      title={titleHint}
    >
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
      {canRetry && (
        <button
          type="button"
          disabled={retrying}
          onClick={(e) => {
            e.stopPropagation();
            if (!retrying) onRetry!(task.task_id, task.label || '');
          }}
          onKeyDown={(e) => e.stopPropagation()}
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
      )}
    </div>
  );
}
