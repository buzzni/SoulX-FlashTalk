/**
 * QueueTrigger — the "작업" pill in the header. Render-only; the
 * parent Radix Popover injects open/close via `PopoverTrigger asChild`.
 * Disabled (not hidden) until the queue snapshot lands, so the header
 * doesn't flicker on layout remounts between wizard and render views.
 * Red dot = work in progress.
 */
import { forwardRef } from 'react';
import Icon from '../Icon.jsx';
import { cn } from '@/lib/utils';

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
      className={cn(
        'relative inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-border rounded-sm text-xs font-medium shadow-[var(--shadow-sm)]',
        active ? 'bg-primary text-white' : 'bg-card text-ink-2',
        loading ? 'cursor-wait opacity-60' : 'cursor-pointer',
      )}
      title={loading ? '작업 목록 불러오는 중…' : '작업 목록 보기'}
    >
      <Icon name="settings" size={12} />
      작업
      {active && (
        <span
          role="status"
          aria-live="polite"
          aria-label="작업 진행 중"
          className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-destructive"
        />
      )}
    </button>
  );
});
