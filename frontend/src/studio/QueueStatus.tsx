/**
 * QueueStatus — queue badge in the header + popover panel.
 *
 * Reads from queueStore (Phase 2a) — the store owns polling lifecycle
 * and refcount-gates subscribers, so this component stops driving
 * network traffic when unmounted without any Provider plumbing.
 *
 * Built on shadcn `Popover` (Radix). Radix handles portal-to-body,
 * anchor positioning, click-outside, escape, focus return — the whole
 * surface that hand-rolling kept getting wrong (the topbar's
 * `overflow-x: auto` clipped a hand-positioned absolute panel).
 *
 * Navigation is self-contained via react-router:
 *   - running/pending → `/render/:taskId` (attach-mode dashboard)
 *   - completed → `/result/:taskId`
 *   - error/cancelled → no target
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueue, usePolling } from '../stores/queueStore';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { QueueTrigger } from './queue/QueueTrigger';
import { QueuePanel } from './queue/QueuePanel';
import { useQueueActions } from './queue/useQueueActions';

export default function QueueStatus() {
  const navigate = useNavigate();
  const { data: queueData, error, refresh } = useQueue();
  const [open, setOpen] = useState(false);
  // Popover open → promote to the 4 s active tier so the panel rows
  // refresh quickly. Popover closed → null tier (no extra sub),
  // store falls back to the 30 s background tier from useQueue alone.
  usePolling(open ? 'active' : null);
  const {
    cancellingIds,
    cancelError,
    cancel,
    retryingIds,
    retryError,
    retry,
  } = useQueueActions(refresh);

  // Retry returns the new task_id; navigate the user to its render page
  // so they immediately see the new attempt instead of having to dig.
  const handleRetry = async (taskId: string, label: string) => {
    const newId = await retry(taskId, label);
    if (newId) {
      setOpen(false);
      navigate(`/render/${encodeURIComponent(newId)}`);
    }
  };

  const loading = !queueData;
  const totalActive = queueData
    ? (queueData.total_running || 0) + (queueData.total_pending || 0)
    : 0;

  const handleOpenLive = (taskId: string) => {
    if (!taskId) return;
    setOpen(false);
    navigate(`/render/${encodeURIComponent(taskId)}`);
  };

  const handleOpenRecent = (taskId: string, _status: string) => {
    if (!taskId) return;
    setOpen(false);
    // All recent statuses (completed / error / cancelled) route to
    // /result/:id. ResultPage renders success copy for completed and a
    // failure summary + 재시도 button for the rest. Previously errored
    // rows were dead-ends — users had to dig the retry control out of
    // the popover.
    navigate(`/result/${encodeURIComponent(taskId)}`);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <QueueTrigger loading={loading} totalActive={totalActive} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[340px] p-3.5 max-h-[70vh] overflow-y-auto overflow-x-hidden"
      >
        {queueData && (
          <QueuePanel
            queueData={queueData}
            error={error}
            cancellingIds={cancellingIds}
            cancelError={cancelError}
            retryingIds={retryingIds}
            retryError={retryError}
            totalActive={totalActive}
            onClose={() => setOpen(false)}
            onOpenLive={handleOpenLive}
            onOpenRecent={handleOpenRecent}
            onCancel={cancel}
            onRetry={handleRetry}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
