// QueueStatus — floating queue badge/panel.
// Reads from the shared QueueProvider so the queue is fetched once per app
// regardless of how many components display it (this + RenderDashboard).
import { useState } from 'react';
import Icon from './Icon.jsx';
import { useQueue } from './QueueContext.jsx';

const typeLabel = (type) => ({
  generate: '쇼호스트 영상',
  conversation: '멀티 대화',
}[type] || (type || '작업'));
const statusLabel = (status) => ({
  pending: '대기 중',
  running: '실행 중',
  completed: '완료',
  error: '오류',
  cancelled: '취소됨',
}[status] || status);

const formatTime = (isoStr) => {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

export default function QueueStatus({ onTaskClick }) {
  const { data: queueData, error } = useQueue();
  const [expanded, setExpanded] = useState(false);

  if (!queueData) return null;

  // Click handler for live (running/pending) items — jumps the user to the
  // RenderDashboard for that task. Recent/finished items are not clickable
  // (would need to re-fetch state to show the played video; out of scope).
  const handleItemClick = (taskId) => {
    if (typeof onTaskClick === 'function' && taskId) {
      onTaskClick(taskId);
      setExpanded(false);
    }
  };
  const clickable = typeof onTaskClick === 'function';

  const totalActive = (queueData.total_running || 0) + (queueData.total_pending || 0);

  const sectionStyle = { marginTop: 10 };
  const sectionHeaderStyle = { fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.04, marginBottom: 6 };
  const itemStyle = {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: 8,
    padding: '8px 10px',
    background: 'var(--bg-sunken)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-sm)',
    fontSize: 12,
    marginBottom: 4,
  };
  const liveItemButtonStyle = {
    ...itemStyle,
    width: '100%',
    cursor: clickable ? 'pointer' : 'default',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 12,
    textAlign: 'left',
  };

  return (
    <div style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 45 }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          background: totalActive > 0 ? 'var(--accent)' : 'var(--bg-elev)',
          color: totalActive > 0 ? '#fff' : 'var(--text-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-sm)',
          fontSize: 12,
          fontWeight: 500,
          cursor: 'pointer',
          boxShadow: 'var(--shadow-sm)',
        }}
        title="작업 큐 상태"
      >
        <Icon name="settings" size={12} />
        큐
        {totalActive > 0 && (
          <span style={{
            background: 'rgba(255,255,255,0.25)',
            borderRadius: 99,
            padding: '0 6px',
            fontSize: 10,
            fontWeight: 700,
          }}>{totalActive}</span>
        )}
      </button>

      {expanded && (
        <div style={{
          position: 'absolute',
          left: 0, bottom: 38,
          width: 340,
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-md)',
          boxShadow: 'var(--shadow-lg)',
          padding: 14,
          maxHeight: '70vh',
          overflowY: 'auto',
        }}>
          <div className="flex justify-between items-center" style={{ marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>작업 큐</strong>
            <button
              onClick={() => setExpanded(false)}
              aria-label="닫기"
              style={{ background: 'transparent', border: 0, cursor: 'pointer', color: 'var(--text-tertiary)' }}
            >
              <Icon name="close" size={14} />
            </button>
          </div>

          {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}

          {queueData.running?.length > 0 && (
            <div style={sectionStyle}>
              <div style={sectionHeaderStyle}>실행 중</div>
              {queueData.running.map(t => (
                <button
                  key={t.task_id}
                  type="button"
                  onClick={() => handleItemClick(t.task_id)}
                  disabled={!clickable}
                  style={liveItemButtonStyle}
                  title={clickable ? '클릭하면 진행 화면으로 이동해요' : undefined}
                >
                  <div>
                    <div style={{ fontWeight: 500 }}>{typeLabel(t.type)}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }} className="mono truncate">{t.label || t.task_id.slice(0, 8)}</div>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 10, color: 'var(--success)' }}>
                    {formatTime(t.started_at)}
                  </div>
                </button>
              ))}
            </div>
          )}

          {queueData.pending?.length > 0 && (
            <div style={sectionStyle}>
              <div style={sectionHeaderStyle}>대기 중 ({queueData.pending.length})</div>
              {queueData.pending.map((t, idx) => (
                <button
                  key={t.task_id}
                  type="button"
                  onClick={() => handleItemClick(t.task_id)}
                  disabled={!clickable}
                  style={liveItemButtonStyle}
                  title={clickable ? '클릭하면 진행 화면으로 이동해요' : undefined}
                >
                  <div>
                    <div style={{ fontWeight: 500 }}>#{idx + 1} · {typeLabel(t.type)}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }} className="mono truncate">{t.label || t.task_id.slice(0, 8)}</div>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 10, color: 'var(--text-tertiary)' }}>
                    {formatTime(t.created_at)}
                  </div>
                </button>
              ))}
            </div>
          )}

          {queueData.recent?.length > 0 && (
            <div style={sectionStyle}>
              <div style={sectionHeaderStyle}>최근 완료</div>
              {queueData.recent.slice(0, 5).map(t => (
                <div key={t.task_id} style={itemStyle}>
                  <div>
                    <div style={{ fontWeight: 500 }}>{typeLabel(t.type)}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }} className="mono truncate">{t.label || t.task_id.slice(0, 8)}</div>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 10, color: t.status === 'error' ? 'var(--danger)' : 'var(--text-tertiary)' }}>
                    {statusLabel(t.status)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {totalActive === 0 && !queueData.recent?.length && (
            <div style={{ color: 'var(--text-tertiary)', fontSize: 12, padding: '10px 0' }}>큐가 비어있어요</div>
          )}
        </div>
      )}
    </div>
  );
}
