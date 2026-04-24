/**
 * LiveTaskRow — one running or pending task in the queue panel.
 *
 * Body is a clickable <button>. If `showCancel` is true (pending rows),
 * a sibling cancel <button> is rendered next to it — HTML doesn't allow
 * nested <button>s so we use two grid columns instead of an onClick
 * on a wrapping element.
 */
import type { ReactNode } from 'react';
import type { QueueEntry } from '../../types/app';
import Icon from '../Icon.jsx';
import { formatTaskTitle } from '../taskFormat.js';
import {
  liveRowWrapperStyle,
  liveItemButtonStyle,
  cancelBtnStyle,
} from './styles';

export interface LiveTaskRowProps {
  task: QueueEntry;
  prefix?: string;
  rightSlot: ReactNode;
  showCancel: boolean;
  cancelling?: boolean;
  cancelTitle?: string;
  onOpen: (taskId: string) => void;
  onCancel?: (taskId: string, label: string) => void;
}

export function LiveTaskRow({
  task,
  prefix = '',
  rightSlot,
  showCancel,
  cancelling = false,
  cancelTitle,
  onOpen,
  onCancel,
}: LiveTaskRowProps) {
  // When there's no cancel button, drop the grid's second column so the
  // main button fills the row.
  const wrapperStyle = showCancel
    ? liveRowWrapperStyle
    : { marginBottom: 4, minWidth: 0 };

  return (
    <div style={wrapperStyle}>
      <button
        type="button"
        onClick={() => onOpen(task.task_id)}
        style={{ ...liveItemButtonStyle, width: '100%' }}
        title="클릭하면 진행 화면으로 이동해요"
      >
        <div style={{ minWidth: 0, overflow: 'hidden' }}>
          <div style={{ fontWeight: 500 }} className="truncate">
            {prefix}
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
        {rightSlot}
      </button>
      {showCancel && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!cancelling) onCancel?.(task.task_id, task.label);
          }}
          disabled={cancelling}
          aria-label="작업 취소"
          title={cancelTitle}
          style={cancelBtnStyle(!cancelling)}
        >
          {cancelling ? (
            <span className="spinner" style={{ width: 11, height: 11 }} />
          ) : (
            <Icon name="close" size={11} />
          )}
        </button>
      )}
    </div>
  );
}
