/**
 * QueueTrigger — the "작업" pill in the header.
 *
 * Disabled while the queue snapshot hasn't landed yet (instead of
 * hiding, which caused a visible flicker every time the header
 * re-mounted between wizard and render views).
 *
 * Badge turns accent-color when at least one task is running/pending.
 *
 * Open/close behaviour is owned by the parent Radix Popover (via
 * `PopoverTrigger asChild`), so this component is render-only — no
 * onClick of its own; Radix injects toggle-on-click through the child.
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
  return (
    <button
      ref={ref}
      type="button"
      disabled={loading}
      {...rest}
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
        <span
          style={{
            background: 'rgba(255,255,255,0.25)',
            borderRadius: 99,
            padding: '0 6px',
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          {totalActive}
        </span>
      )}
    </button>
  );
});
