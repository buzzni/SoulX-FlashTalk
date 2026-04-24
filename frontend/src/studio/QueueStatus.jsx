// QueueStatus — floating queue badge/panel.
// Reads from the shared QueueProvider so the queue is fetched once per app
// regardless of how many components display it (this + RenderDashboard).
// Navigation is self-contained via react-router:
//   - completed → /result/:taskId (dedicated result page)
//   - running/pending → /?attach=:taskId (wizard route w/ attach hint that
//     HostStudio picks up via useSearchParams)
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon.jsx';
import { cancelQueuedTask, humanizeError } from './api.js';
import { useQueue } from './QueueContext.jsx';
import { formatTaskTitle } from './taskFormat.js';

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

export default function QueueStatus() {
  const navigate = useNavigate();
  const { data: queueData, error, refresh } = useQueue();
  const [expanded, setExpanded] = useState(false);
  const [cancellingIds, setCancellingIds] = useState(new Set());
  const [cancelError, setCancelError] = useState(null);

  // Queue snapshot not loaded yet — keep the button in place so the header
  // layout doesn't shift, but disable interaction until we have data. Hiding
  // the button created a visible "it was here a second ago" flicker every
  // time the header re-mounted.
  const loading = !queueData;

  // Live item click → attach to the running/pending task from the wizard
  // route. HostStudio reads ?attach= on mount and switches into attach mode.
  const handleLiveClick = (taskId) => {
    if (!taskId) return;
    setExpanded(false);
    navigate(`/?attach=${encodeURIComponent(taskId)}`);
  };
  // Finished task → dedicated result page.
  const handleRecentClick = (taskId, status) => {
    if (!taskId) return;
    setExpanded(false);
    if (status === 'completed') navigate(`/result/${encodeURIComponent(taskId)}`);
    // error/cancelled: no clickable target (no video to show)
  };

  const handleCancel = async (taskId, label) => {
    if (!window.confirm(`이 작업을 취소할까요?\n${label || taskId}`)) return;
    setCancellingIds(prev => { const next = new Set(prev); next.add(taskId); return next; });
    setCancelError(null);
    try {
      await cancelQueuedTask(taskId);
      refresh(); // pull fresh queue snapshot so the row drops out
    } catch (err) {
      setCancelError(humanizeError(err));
    } finally {
      setCancellingIds(prev => { const next = new Set(prev); next.delete(taskId); return next; });
    }
  };

  const totalActive = queueData ? (queueData.total_running || 0) + (queueData.total_pending || 0) : 0;

  const sectionStyle = { marginTop: 10 };
  const sectionHeaderStyle = { fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.04, marginBottom: 6 };
  // Note on min-width:0 sprinkled below — CSS Grid's `1fr` track has an
  // implicit min-width:auto that expands to the longest descendant. Long task
  // labels (queue_label can hit 80 chars) would push each row past the 340px
  // panel width and produce horizontal scroll. min-width:0 + overflow:hidden
  // on grid items lets `truncate` (text-overflow: ellipsis) actually clip.
  const itemStyle = {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: 8,
    padding: '8px 10px',
    background: 'var(--bg-sunken)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-sm)',
    fontSize: 12,
    marginBottom: 4,
    minWidth: 0,
    overflow: 'hidden',
  };
  // Live row layout: clickable body + (optional) cancel button. Using a
  // wrapping <div> instead of nesting buttons (HTML doesn't allow <button>
  // inside <button>) — the body is a button, the cancel is a sibling.
  const liveRowWrapperStyle = {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: 6,
    alignItems: 'stretch',
    marginBottom: 4,
    minWidth: 0,
  };
  const liveItemButtonStyle = {
    ...itemStyle,
    width: '100%',
    cursor: 'pointer',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 12,
    textAlign: 'left',
    marginBottom: 0,
    minWidth: 0,
  };
  const cancelBtnStyle = (enabled) => ({
    width: 28,
    background: 'var(--bg-sunken)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-sm)',
    cursor: enabled ? 'pointer' : 'not-allowed',
    color: enabled ? 'var(--text-secondary)' : 'var(--text-tertiary)',
    display: 'grid',
    placeItems: 'center',
    padding: 0,
  });

  const renderLiveRow = (t, { showCancel, cancelTitle, prefix, rightSlot }) => {
    const cancelling = cancellingIds.has(t.task_id);
    // When the cancel button is hidden (running tasks — backend can't kill
    // them), drop the grid's second column so the main button fills the row.
    const wrapperStyle = showCancel
      ? liveRowWrapperStyle
      : { marginBottom: 4, minWidth: 0 };
    return (
      <div key={t.task_id} style={wrapperStyle}>
        <button
          type="button"
          onClick={() => handleLiveClick(t.task_id)}
          style={{ ...liveItemButtonStyle, width: '100%' }}
          title="클릭하면 진행 화면으로 이동해요"
        >
          <div style={{ minWidth: 0, overflow: 'hidden' }}>
            <div style={{ fontWeight: 500 }} className="truncate">
              {prefix}{formatTaskTitle(t.task_id, t.type)}
            </div>
            {t.label && (
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }} className="truncate">{t.label}</div>
            )}
          </div>
          {rightSlot}
        </button>
        {showCancel && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (!cancelling) handleCancel(t.task_id, t.label); }}
            disabled={cancelling}
            aria-label="작업 취소"
            title={cancelTitle}
            style={cancelBtnStyle(!cancelling)}
          >
            {cancelling ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <Icon name="close" size={11} />}
          </button>
        )}
      </div>
    );
  };

  // Moved from fixed bottom-left to inline — intended to sit inside the
  // TopBar's right group. Container is position: relative so the dropdown
  // panel can absolute-position off the button; caller controls outer
  // layout / margins.
  return (
    <div style={{ position: 'relative', display: 'inline-block', zIndex: 45 }}>
      <button
        onClick={() => { if (!loading) setExpanded(e => !e); }}
        disabled={loading}
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
          cursor: loading ? 'wait' : 'pointer',
          opacity: loading ? 0.6 : 1,
          boxShadow: 'var(--shadow-sm)',
        }}
        title={loading ? '작업 목록 불러오는 중…' : '작업 목록 보기'}
      >
        <Icon name="settings" size={12} />
        작업
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
          // min-width:0 fixes below, ensure long task labels can't push the
          // panel wider than 340px.
          overflowX: 'hidden',
          boxSizing: 'border-box',
        }}>
          <div className="flex justify-between items-center" style={{ marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>작업 목록</strong>
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
              {queueData.running.map(t => renderLiveRow(t, {
                // Backend can't kill a task mid-inference (worker is in a sync
                // FlashTalk/Gemini call) — just hide the cancel button rather
                // than showing a dead control that always says "can't cancel".
                showCancel: false,
                prefix: '',
                rightSlot: (
                  <div style={{ textAlign: 'right', fontSize: 10, color: 'var(--success)' }}>
                    {formatTime(t.started_at)}
                  </div>
                ),
              }))}
            </div>
          )}

          {queueData.pending?.length > 0 && (
            <div style={sectionStyle}>
              <div style={sectionHeaderStyle}>대기 중 ({queueData.pending.length})</div>
              {queueData.pending.map((t, idx) => renderLiveRow(t, {
                showCancel: true,
                cancelTitle: '대기 중인 작업 취소',
                prefix: `#${idx + 1} · `,
                rightSlot: (
                  <div style={{ textAlign: 'right', fontSize: 10, color: 'var(--text-tertiary)' }}>
                    {formatTime(t.created_at)}
                  </div>
                ),
              }))}
            </div>
          )}

          {cancelError && (
            <div style={{ marginTop: 8, padding: '6px 8px', background: 'var(--danger-soft)', color: 'var(--danger)', borderRadius: 'var(--r-sm)', fontSize: 11 }}>
              {cancelError}
            </div>
          )}

          {queueData.recent?.length > 0 && (
            <div style={sectionStyle}>
              <div style={sectionHeaderStyle}>최근 완료</div>
              {queueData.recent.slice(0, 5).map(t => {
                // Completed tasks → clickable, navigates to /result/:taskId.
                // Error/cancelled tasks stay static (no result to show).
                const canOpen = t.status === 'completed';
                const Wrapper = canOpen ? 'button' : 'div';
                const wrapperProps = canOpen ? {
                  type: 'button',
                  onClick: () => handleRecentClick(t.task_id, t.status),
                  style: {
                    ...itemStyle,
                    width: '100%',
                    cursor: 'pointer',
                    color: 'inherit',
                    fontFamily: 'inherit',
                    fontSize: 12,
                    textAlign: 'left',
                  },
                  title: '결과 영상 보기',
                } : { style: itemStyle };
                return (
                  <Wrapper key={t.task_id} {...wrapperProps}>
                    <div style={{ minWidth: 0, overflow: 'hidden' }}>
                      <div style={{ fontWeight: 500 }} className="truncate">
                        {formatTaskTitle(t.task_id, t.type)}
                      </div>
                      {t.label && (
                        <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }} className="truncate">{t.label}</div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 10, color: t.status === 'error' ? 'var(--danger)' : 'var(--text-tertiary)' }}>
                      {statusLabel(t.status)}
                    </div>
                  </Wrapper>
                );
              })}
            </div>
          )}

          {totalActive === 0 && !queueData.recent?.length && (
            <div style={{ color: 'var(--text-tertiary)', fontSize: 12, padding: '10px 0' }}>처리할 작업이 없어요</div>
          )}
        </div>
      )}
    </div>
  );
}
