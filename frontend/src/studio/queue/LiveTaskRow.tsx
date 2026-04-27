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
import { Spinner } from '@/components/spinner';
import { cn } from '@/lib/utils';
import {
  LIVE_WRAPPER_WITH_CANCEL_CLASS,
  LIVE_WRAPPER_NO_CANCEL_CLASS,
  ROW_BUTTON_CLASS,
  CANCEL_BTN_BASE_CLASS,
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
  return (
    <div className={showCancel ? LIVE_WRAPPER_WITH_CANCEL_CLASS : LIVE_WRAPPER_NO_CANCEL_CLASS}>
      <button
        type="button"
        onClick={() => onOpen(task.task_id)}
        className={ROW_BUTTON_CLASS}
        title="클릭하면 진행 화면으로 이동해요"
      >
        <div className="min-w-0 overflow-hidden">
          <div className="font-medium truncate">
            {prefix}
            {formatTaskTitle(task.task_id, task.type)}
          </div>
          {task.label && (
            <div className="text-[10px] text-ink-3 truncate">{task.label}</div>
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
          className={cn(
            CANCEL_BTN_BASE_CLASS,
            cancelling ? 'cursor-not-allowed text-ink-3' : 'cursor-pointer text-ink-2',
          )}
        >
          {cancelling ? (
            <Spinner size="xs" />
          ) : (
            <Icon name="close" size={11} />
          )}
        </button>
      )}
    </div>
  );
}
