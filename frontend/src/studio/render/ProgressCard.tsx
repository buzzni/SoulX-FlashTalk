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
        <div className="flex justify-between" style={{ marginBottom: 6, fontSize: 12 }}>
          <span className="text-secondary">
            {message || STAGES[currentStageIdx]?.label}
          </span>
          <span className="num mono text-secondary">{Math.floor(progressPct)}%</span>
        </div>
        <div className="progress">
          <div className="progress-bar" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      {/* Timestamps stack vertically — labels are long ("작업생성날짜") and
           inline they wrapped messily on the narrow card column. */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          fontSize: 11,
          color: 'var(--text-tertiary)',
        }}
      >
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
          const done = i < currentStageIdx;
          const active = i === currentStageIdx;
          const isLast = i === STAGES.length - 1;
          return (
            <div key={s.key} className="grid grid-cols-[28px_1fr] gap-3 items-stretch">
              {/* Left rail — dot + connector line */}
              <div className="flex flex-col items-center">
                <div
                  className={`grid place-items-center size-6 rounded-full transition-colors ${
                    done
                      ? 'bg-success text-white'
                      : active
                        ? 'bg-primary text-white'
                        : 'bg-card border border-border text-muted-foreground'
                  }`}
                >
                  {done ? (
                    <Check className="size-3.5" />
                  ) : active ? (
                    <Spinner size="xs" />
                  ) : (
                    <span className="text-[10px] font-bold tabular-nums">{i + 1}</span>
                  )}
                </div>
                {!isLast && (
                  <div
                    className={`flex-1 w-0.5 my-1 transition-colors ${
                      done ? 'bg-success' : 'bg-border'
                    }`}
                    style={{ minHeight: 18 }}
                  />
                )}
              </div>
              {/* Right — label + status */}
              <div className={`pb-3 ${active ? '' : ''}`}>
                <div
                  className={`text-[12.5px] font-semibold tracking-[-0.012em] ${
                    done
                      ? 'text-success-on-soft'
                      : active
                        ? 'text-foreground'
                        : 'text-muted-foreground'
                  }`}
                >
                  {s.label}
                </div>
                {active && message && (
                  <div className="text-[11px] text-muted-foreground mt-0.5">
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
