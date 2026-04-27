/**
 * QueueTrigger — the "작업" pill in the header. Render-only; the
 * parent Radix Popover injects open/close via `PopoverTrigger asChild`.
 * Disabled (not hidden) until the queue snapshot lands, so the header
 * doesn't flicker on layout remounts between wizard and render views.
 * Red dot = work in progress.
 */
import { forwardRef } from 'react';
import Icon from '../Icon.jsx';

export interface QueueTriggerProps {
  loading: boolean;
  totalActive: number;
}

export const QueueTrigger = forwardRef<HTMLButtonElement, QueueTriggerProps & React.ButtonHTMLAttributes<HTMLButtonElement>>(function QueueTrigger(
  { loading, totalActive, ...rest },
  ref,
) {
  const active = totalActive > 0;
  const ariaLabel = loading
    ? '작업 목록 불러오는 중'
    : active
      ? '작업 목록 보기. 진행 중인 작업이 있습니다.'
      : '작업 목록 보기. 진행 중인 작업이 없습니다.';
  return (
    <button
      ref={ref}
      type="button"
      disabled={loading}
      aria-label={ariaLabel}
      {...rest}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        background: active ? 'var(--accent)' : 'var(--bg-elev)',
        color: active ? '#fff' : 'var(--text-secondary)',
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
      {active && (
        // Red dot — single liveness indicator. Pulse animation is
        // disabled globally under prefers-reduced-motion (index.css:281).
        // role/aria-live announces state changes to screen readers
        // since the dot is a color-only visual signal.
        <span
          role="status"
          aria-live="polite"
          aria-label="작업 진행 중"
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            width: 8,
            height: 8,
            borderRadius: 999,
            background: 'var(--destructive)',
            boxShadow: '0 0 0 3px var(--destructive-soft)',
            animation: 'var(--animate-pulse-slow)',
          }}
        />
      )}
    </button>
  );
});
