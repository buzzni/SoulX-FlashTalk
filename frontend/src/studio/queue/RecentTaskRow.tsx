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
import { itemStyle } from './styles';

export interface RecentTaskRowProps {
  task: QueueEntry;
  onOpen: (taskId: string, status: string) => void;
}

export function RecentTaskRow({ task, onOpen }: RecentTaskRowProps) {
  const canOpen = task.status === 'completed';

  const body = (
    <>
      <div style={{ minWidth: 0, overflow: 'hidden' }}>
        <div style={{ fontWeight: 500 }} className="truncate">
          {formatTaskTitle(task.task_id, task.type)}
        </div>
        {task.label && (
          <div
            style={{ fontSize: 10, color: 'var(--text-tertiary)' }}
            className="truncate"
          >
            {task.label}
          </div>
        )}
      </div>
      <div
        style={{
          textAlign: 'right',
          fontSize: 10,
          color: task.status === 'error' ? 'var(--danger)' : 'var(--text-tertiary)',
        }}
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
        style={{
          ...itemStyle,
          width: '100%',
          cursor: 'pointer',
          color: 'inherit',
          fontFamily: 'inherit',
          fontSize: 12,
          textAlign: 'left',
        }}
        title="결과 영상 보기"
      >
        {body}
      </button>
    );
  }

  return <div style={itemStyle}>{body}</div>;
}
