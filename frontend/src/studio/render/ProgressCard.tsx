/**
 * ProgressCard — the middle "what's happening right now" block.
 *
 * Three stacked sections (while the job is running):
 *   1. Progress bar + backend message + percentage
 *   2. Timestamps: elapsed, created_at, started_at, queue position
 *   3. 5-stage checklist with done / active / pending indicators
 *
 * When the job flips to done/error, the parent component hides this
 * card and renders RenderStats instead.
 */

import { Check } from 'lucide-react';
import { Spinner } from '@/components/spinner';
import { STAGES, formatDateTime, formatElapsed } from './stages';

type StageState = 'done' | 'active' | 'idle';

const DOT_CLASS: Record<StageState, string> = {
  done: 'bg-success text-white',
  active: 'bg-primary text-white',
  idle: 'bg-card border border-border text-muted-foreground',
};
const LABEL_CLASS: Record<StageState, string> = {
  done: 'text-success-on-soft',
  active: 'text-foreground',
  idle: 'text-muted-foreground',
};

export interface ProgressCardProps {
  currentStageIdx: number;
  /** 0-100 range (percent). */
  progressPct: number;
  message: string | null;
  /** ms; null while pending (no start timestamp yet). */
  elapsedMs: number | null;
  createdAt?: string | null;
  startedAt?: string | null;
  queuePosition: number | null;
}

export function ProgressCard({
  currentStageIdx,
  progressPct,
  message,
  elapsedMs,
  createdAt,
  startedAt,
  queuePosition,
}: ProgressCardProps) {
  return (
    <>
      <div>
        <div className="flex justify-between mb-1.5 text-xs">
          <span className="text-ink-2">
            {message || STAGES[currentStageIdx]?.label}
          </span>
          <span className="num mono text-ink-2">{Math.floor(progressPct)}%</span>
        </div>
        <div className="progress">
          <div className="progress-bar" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      {/* Timestamps stack vertically — labels are long ("작업생성날짜") and
           inline they wrapped messily on the narrow card column. */}
      <div className="flex flex-col gap-1 text-2xs text-ink-3">
        <span className="mono num">
          {elapsedMs == null ? '경과 — (대기 중)' : `경과 ${formatElapsed(elapsedMs)}`}
        </span>
        {createdAt && (
          <span title="작업이 작업 목록에 등록된 시각">
            작업생성날짜 {formatDateTime(createdAt)}
          </span>
        )}
        {startedAt && (
          <span title="실제 작업이 시작된 시각">
            작업시작날짜 {formatDateTime(startedAt)}
          </span>
        )}
        {queuePosition != null && queuePosition > 0 && (
          <span>대기열 {queuePosition}번째</span>
        )}
      </div>

      {/* Stage timeline — connector dots + lines, with active stage shimmer */}
      <div className="flex flex-col gap-0">
        {STAGES.map((s, i) => {
          const state: StageState =
            i < currentStageIdx ? 'done' : i === currentStageIdx ? 'active' : 'idle';
          const isDone = state === 'done';
          const isActive = state === 'active';
          const isLast = i === STAGES.length - 1;
          return (
            <div key={s.key} className="grid grid-cols-[28px_1fr] gap-3 items-stretch">
              {/* Left rail — dot + connector line */}
              <div className="flex flex-col items-center">
                <div className={`grid place-items-center size-6 rounded-full transition-colors ${DOT_CLASS[state]}`}>
                  {isDone ? (
                    <Check className="size-3.5" />
                  ) : isActive ? (
                    <Spinner size="xs" />
                  ) : (
                    <span className="text-2xs font-bold tabular-nums">{i + 1}</span>
                  )}
                </div>
                {!isLast && (
                  <div className={`flex-1 w-0.5 my-1 min-h-[18px] transition-colors ${isDone ? 'bg-success' : 'bg-border'}`} />
                )}
              </div>
              {/* Right — label + status */}
              <div className="pb-3">
                <div className={`text-xs font-semibold tracking-tight ${LABEL_CLASS[state]}`}>
                  {s.label}
                </div>
                {isActive && message && (
                  <div className="text-2xs text-muted-foreground mt-0.5">
                    {message}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
