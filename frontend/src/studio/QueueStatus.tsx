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
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueue, usePolling } from '../stores/queueStore';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { QueueTrigger } from './queue/QueueTrigger';
import { QueuePanel } from './queue/QueuePanel';
import { useQueueActions } from './queue/useQueueActions';
import { ConfirmModal } from '../components/confirm-modal';

interface PendingAction {
  type: 'cancel' | 'retry';
  taskId: string;
  label: string;
}

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

  // Confirm modal lives one level up from the rows so a single instance
  // covers cancel + retry across all rows. State holds the pending
  // action; null means no modal open. Row click → set pending →
  // ConfirmModal renders → confirm runs the hook action.
  const [pending, setPending] = useState<PendingAction | null>(null);
  // Double-click guard. The modal closes synchronously inside runPending
  // (setPending(null) before await), but two click events in the same
  // event-loop tick share the same closure — both see `pending` as
  // truthy and both fire the API call. A ref flips on entry and blocks
  // the second invocation, since refs read the live value not the
  // closed-over state. Cancellingds/retryingIds only dedupe per task,
  // not per modal instance.
  const inFlightRef = useRef(false);

  // Wrappers the rows call. These don't run the action — they queue
  // a confirm. ConfirmModal's onConfirm runs the real hook function.
  const askCancel = (taskId: string, label: string) => {
    setPending({ type: 'cancel', taskId, label });
  };
  const askRetry = (taskId: string, label: string) => {
    setPending({ type: 'retry', taskId, label });
  };

  const runPending = async () => {
    if (inFlightRef.current) return;
    if (!pending) return;
    inFlightRef.current = true;
    const { type, taskId, label } = pending;
    setPending(null);
    try {
      if (type === 'cancel') {
        await cancel(taskId, label);
        return;
      }
      // Retry returns the new task_id; navigate to it so the user lands
      // on the new attempt instead of staring at the popover.
      const newId = await retry(taskId, label);
      if (newId) {
        setOpen(false);
        navigate(`/render/${encodeURIComponent(newId)}`);
      }
    } finally {
      inFlightRef.current = false;
    }
  };

  // Loading only while the very first fetch is in flight (no data, no
  // error yet). Once an error lands we want the trigger enabled so the
  // user can open the panel and see the error + a manual retry — the
  // alternative (disabled forever on persistent backend failure) leaves
  // the user with no channel to learn the queue is broken.
  const loading = !queueData && !error;
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
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <QueueTrigger loading={loading} totalActive={totalActive} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[340px] p-3.5 max-h-[70vh] overflow-y-auto overflow-x-hidden"
      >
        {queueData ? (
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
            onCancel={askCancel}
            onRetry={askRetry}
          />
        ) : (
          // No snapshot yet — either the first fetch is still in flight
          // (loading) or it failed (error). Without this branch, opening
          // the panel mid-failure showed a blank box; the user had no way
          // to see what went wrong or trigger another attempt.
          <div className="py-2">
            <div className="flex justify-between items-center mb-2">
              <strong className="text-sm-tight">작업 목록</strong>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="닫기"
                className="bg-transparent border-0 cursor-pointer text-ink-3"
              >
                ✕
              </button>
            </div>
            {error ? (
              <div className="space-y-2">
                <div className="text-destructive text-xs">{error}</div>
                <button
                  type="button"
                  onClick={() => { void refresh(); }}
                  className="w-full px-2 py-1.5 border border-border rounded-sm text-xs hover:bg-secondary cursor-pointer"
                >
                  다시 시도
                </button>
              </div>
            ) : (
              <div className="text-ink-3 text-xs py-2.5">불러오는 중…</div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
    <ConfirmModal
      open={pending?.type === 'cancel'}
      title="이 작업을 취소할까요?"
      description={
        pending?.type === 'cancel' ? (
          <p className="m-0 leading-relaxed">
            {pending.label || pending.taskId}
            <br />
            <span className="text-muted-foreground">큐에서 제거되고 되돌릴 수 없어요.</span>
          </p>
        ) : null
      }
      confirmLabel="취소하기"
      cancelLabel="유지"
      variant="danger"
      onConfirm={runPending}
      onCancel={() => setPending(null)}
    />
    <ConfirmModal
      open={pending?.type === 'retry'}
      title="이 작업을 다시 시도할까요?"
      description={
        pending?.type === 'retry' ? (
          <p className="m-0 leading-relaxed">
            {pending.label || pending.taskId}
            <br />
            <span className="text-muted-foreground">같은 입력으로 새 작업을 만들어요.</span>
          </p>
        ) : null
      }
      confirmLabel="재시도"
      onConfirm={runPending}
      onCancel={() => setPending(null)}
    />
    </>
  );
}
