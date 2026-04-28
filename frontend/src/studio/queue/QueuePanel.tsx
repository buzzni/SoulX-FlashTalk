/**
 * QueuePanel — inner content for the queue popover.
 *
 * Wrapping (portal, anchor positioning, click-outside, escape) lives
 * in QueueStatus via shadcn `Popover` (Radix). This component only
 * renders the body: header + sections (실행 중 / 대기 중 / 최근 완료) +
 * empty-state.
 *
 * No X close button — Radix's outside-click + Esc already cover that
 * surface, and a redundant X in a 340-px wide panel header just steals
 * space from the title.
 */
import { Link } from 'react-router-dom';
import type { QueueSnapshot } from '../../types/app';
import { LiveTaskRow } from './LiveTaskRow';
import { RecentTaskRow } from './RecentTaskRow';
import { formatTime } from './queueFormat';
import { SECTION_CLASS, SECTION_HEADER_CLASS } from './styles';

const RECENT_VISIBLE_LIMIT = 5;

export interface QueuePanelProps {
  queueData: QueueSnapshot;
  error: string | null;
  cancellingIds: Set<string>;
  cancelError: string | null;
  retryingIds: Set<string>;
  retryError: string | null;
  totalActive: number;
  /** Refire the queue fetch — wired to the inline retry button when
   * polling errored against a still-displayed stale snapshot. */
  onRefresh: () => void;
  /** Close the popover. Used by the recent-section "전체 보기" link
   * so the popover collapses behind the navigation. */
  onClose: () => void;
  onOpenLive: (taskId: string) => void;
  onOpenRecent: (taskId: string, status: string) => void;
  onCancel: (taskId: string, label: string) => void;
  onRetry: (taskId: string, label: string) => void;
}

export function QueuePanel({
  queueData,
  error,
  cancellingIds,
  cancelError,
  retryingIds,
  retryError,
  totalActive,
  onRefresh,
  onClose,
  onOpenLive,
  onOpenRecent,
  onCancel,
  onRetry,
}: QueuePanelProps) {
  const running = queueData.running ?? [];
  const pending = queueData.pending ?? [];
  const recent = queueData.recent ?? [];
  const hasMoreRecent = recent.length > RECENT_VISIBLE_LIMIT;

  return (
    <div>
      <div className="mb-2">
        <strong className="text-sm-tight">작업 목록</strong>
      </div>

      {error && (
        <div className="mb-2 px-2 py-1.5 bg-destructive-soft rounded-sm flex items-center justify-between gap-2">
          <span className="text-destructive text-xs">{error}</span>
          <button
            type="button"
            onClick={onRefresh}
            className="text-xs text-destructive underline cursor-pointer shrink-0"
          >
            다시 시도
          </button>
        </div>
      )}

      {running.length > 0 && (
        <div className={SECTION_CLASS}>
          <div className={SECTION_HEADER_CLASS}>실행 중</div>
          {running.map((t) => (
            <LiveTaskRow
              key={t.task_id}
              task={t}
              // Backend can't kill a task mid-inference (worker is in a sync
              // FlashTalk/Gemini call) — hide the cancel button rather than
              // showing a dead control that always says "can't cancel".
              showCancel={false}
              onOpen={onOpenLive}
              rightSlot={
                <div className="text-right text-2xs text-success">
                  {formatTime(t.started_at)}
                </div>
              }
            />
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div className={SECTION_CLASS}>
          <div className={SECTION_HEADER_CLASS}>대기 중 ({pending.length})</div>
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
                <div className="text-right text-2xs text-ink-3">
                  {formatTime(t.created_at)}
                </div>
              }
            />
          ))}
        </div>
      )}

      {cancelError && (
        <div className="mt-2 px-2 py-1.5 bg-destructive-soft text-destructive rounded-sm text-2xs">
          {cancelError}
        </div>
      )}

      {recent.length > 0 && (
        <div className={SECTION_CLASS}>
          <div className={SECTION_HEADER_CLASS}>최근 완료</div>
          {recent.slice(0, RECENT_VISIBLE_LIMIT).map((t) => (
            <RecentTaskRow
              key={t.task_id}
              task={t}
              onOpen={onOpenRecent}
              onRetry={onRetry}
              retrying={retryingIds.has(t.task_id)}
            />
          ))}
          {/* The popover only shows the latest 5 — anything beyond that
              was previously unreachable from this surface. /results is
              the canonical library view, so route the user there for
              the long tail. Closing the popover behind the link keeps
              the back button working as expected. */}
          {hasMoreRecent && (
            <Link
              to="/results"
              onClick={onClose}
              className="block text-center text-2xs text-ink-2 underline mt-1 py-1 hover:text-ink-1"
            >
              전체 보기
            </Link>
          )}
        </div>
      )}

      {retryError && (
        <div className="mt-2 px-2 py-1.5 bg-destructive-soft text-destructive rounded-sm text-2xs">
          {retryError}
        </div>
      )}

      {totalActive === 0 && recent.length === 0 && (
        <div className="text-ink-3 text-xs py-2.5">처리할 작업이 없어요</div>
      )}
    </div>
  );
}
