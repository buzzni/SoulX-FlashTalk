/**
 * QueuePanel — the 340px dropdown rendered when the trigger is clicked.
 *
 * Stateless wrt what to fetch — consumes the queue snapshot + action
 * callbacks from the container. Sections render in fixed order
 * (실행 중 → 대기 중 → 최근 완료); each section is suppressed when empty,
 * and a friendly empty-state takes over when the whole thing is empty.
 */
import type { QueueSnapshot } from '../../types/app';
import Icon from '../Icon.jsx';
import { LiveTaskRow } from './LiveTaskRow';
import { RecentTaskRow } from './RecentTaskRow';
import { formatTime } from './queueFormat';
import { sectionStyle, sectionHeaderStyle } from './styles';

export interface QueuePanelProps {
  queueData: QueueSnapshot;
  error: string | null;
  cancellingIds: Set<string>;
  cancelError: string | null;
  totalActive: number;
  onClose: () => void;
  onOpenLive: (taskId: string) => void;
  onOpenRecent: (taskId: string, status: string) => void;
  onCancel: (taskId: string, label: string) => void;
}

export function QueuePanel({
  queueData,
  error,
  cancellingIds,
  cancelError,
  totalActive,
  onClose,
  onOpenLive,
  onOpenRecent,
  onCancel,
}: QueuePanelProps) {
  const running = queueData.running ?? [];
  const pending = queueData.pending ?? [];
  const recent = queueData.recent ?? [];

  return (
    <div
      style={{
        position: 'absolute',
        right: 0,
        top: 'calc(100% + 6px)',
        width: 340,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-md)',
        boxShadow: 'var(--shadow-lg)',
        padding: 14,
        maxHeight: '70vh',
        overflowY: 'auto',
        // Belt-and-braces against horizontal scroll: even with the
        // min-width:0 fixes inside rows, ensure long task labels can't
        // push the panel wider than 340px.
        overflowX: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      <div className="flex justify-between items-center" style={{ marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>작업 목록</strong>
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          style={{
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
            color: 'var(--text-tertiary)',
          }}
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}

      {running.length > 0 && (
        <div style={sectionStyle}>
          <div style={sectionHeaderStyle}>실행 중</div>
          {running.map((t) => (
            <LiveTaskRow
              key={t.task_id}
              task={t}
              // Backend can't kill a task mid-inference (worker is in a sync
              // FlashTalk/Gemini call) — just hide the cancel button rather
              // than showing a dead control that always says "can't cancel".
              showCancel={false}
              onOpen={onOpenLive}
              rightSlot={
                <div
                  style={{ textAlign: 'right', fontSize: 10, color: 'var(--success)' }}
                >
                  {formatTime(t.started_at)}
                </div>
              }
            />
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div style={sectionStyle}>
          <div style={sectionHeaderStyle}>대기 중 ({pending.length})</div>
          {pending.map((t, idx) => (
            <LiveTaskRow
              key={t.task_id}
              task={t}
              showCancel
              cancelling={cancellingIds.has(t.task_id)}
              cancelTitle="대기 중인 작업 취소"
              prefix={`#${idx + 1} · `}
              onOpen={onOpenLive}
              onCancel={onCancel}
              rightSlot={
                <div
                  style={{
                    textAlign: 'right',
                    fontSize: 10,
                    color: 'var(--text-tertiary)',
                  }}
                >
                  {formatTime(t.created_at)}
                </div>
              }
            />
          ))}
        </div>
      )}

      {cancelError && (
        <div
          style={{
            marginTop: 8,
            padding: '6px 8px',
            background: 'var(--danger-soft)',
            color: 'var(--danger)',
            borderRadius: 'var(--r-sm)',
            fontSize: 11,
          }}
        >
          {cancelError}
        </div>
      )}

      {recent.length > 0 && (
        <div style={sectionStyle}>
          <div style={sectionHeaderStyle}>최근 완료</div>
          {recent.slice(0, 5).map((t) => (
            <RecentTaskRow key={t.task_id} task={t} onOpen={onOpenRecent} />
          ))}
        </div>
      )}

      {totalActive === 0 && recent.length === 0 && (
        <div
          style={{ color: 'var(--text-tertiary)', fontSize: 12, padding: '10px 0' }}
        >
          처리할 작업이 없어요
        </div>
      )}
    </div>
  );
}
