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

import Icon from '../Icon.jsx';
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

      {/* Stage checklist — vertical so the per-stage label can read in full. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {STAGES.map((s, i) => {
          const done = i < currentStageIdx;
          const active = i === currentStageIdx;
          return (
            <div
              key={s.key}
              style={{
                padding: '8px 10px',
                background: done
                  ? 'var(--success-soft)'
                  : active
                    ? 'var(--accent-soft)'
                    : 'var(--bg-sunken)',
                borderRadius: 6,
                border: `1px solid ${
                  done
                    ? 'oklch(0.85 0.05 160)'
                    : active
                      ? 'var(--accent-soft-border)'
                      : 'var(--border)'
                }`,
                fontSize: 11,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              {done ? (
                <Icon name="check" size={12} style={{ color: 'var(--success)' }} />
              ) : active ? (
                <span className="spinner" style={{ width: 11, height: 11 }} />
              ) : (
                <div
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 99,
                    border: '1.5px solid var(--border-strong)',
                  }}
                />
              )}
              <span className={done ? '' : active ? '' : 'text-tertiary'}>{s.label}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
