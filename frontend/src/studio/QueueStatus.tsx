/**
 * QueueStatus — queue badge in the header + expand-panel popover.
 *
 * Reads from queueStore (Phase 2a) — the store owns polling lifecycle
 * and refcount-gates subscribers, so this component stops driving
 * network traffic when unmounted without any Provider plumbing.
 *
 * Navigation is self-contained via react-router:
 *   - running/pending → `/?attach=:taskId` (HostStudio picks up
 *     `?attach=` via useSearchParams and flips into attach mode)
 *   - completed → `/result/:taskId` (dedicated result page)
 *   - error/cancelled → no target (no video to show)
 *
 * Rendering is delegated to QueueTrigger + QueuePanel; cancel logic
 * lives in useQueueActions.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueue } from '../stores/queueStore';
import { QueueTrigger } from './queue/QueueTrigger';
import { QueuePanel } from './queue/QueuePanel';
import { useQueueActions } from './queue/useQueueActions';

export default function QueueStatus() {
  const navigate = useNavigate();
  const { data: queueData, error, refresh } = useQueue();
  const [expanded, setExpanded] = useState(false);
  const { cancellingIds, cancelError, cancel } = useQueueActions(refresh);

  // Queue snapshot not loaded yet — keep the button in place so the
  // header layout doesn't shift, but disable interaction until we have
  // data.
  const loading = !queueData;

  const totalActive = queueData
    ? (queueData.total_running || 0) + (queueData.total_pending || 0)
    : 0;

  const handleOpenLive = (taskId: string) => {
    if (!taskId) return;
    setExpanded(false);
    navigate(`/?attach=${encodeURIComponent(taskId)}`);
  };

  const handleOpenRecent = (taskId: string, status: string) => {
    if (!taskId) return;
    setExpanded(false);
    if (status === 'completed') {
      navigate(`/result/${encodeURIComponent(taskId)}`);
    }
    // error/cancelled: no clickable target — RecentTaskRow renders a
    // plain <div> in that case, so this branch shouldn't fire.
  };

  return (
    <div style={{ position: 'relative', display: 'inline-block', zIndex: 45 }}>
      <QueueTrigger
        loading={loading}
        totalActive={totalActive}
        onClick={() => setExpanded((e) => !e)}
      />
      {expanded && queueData && (
        <QueuePanel
          queueData={queueData}
          error={error}
          cancellingIds={cancellingIds}
          cancelError={cancelError}
          totalActive={totalActive}
          onClose={() => setExpanded(false)}
          onOpenLive={handleOpenLive}
          onOpenRecent={handleOpenRecent}
          onCancel={cancel}
        />
      )}
    </div>
  );
}
