import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * OptionCard — large pickable card for top-level mode pickers.
 *
 * Used wherever the wizard asks the user to commit to one of N
 * substantially different paths (e.g. AI 음성 vs 내 녹음 그대로 쓰기,
 * 이미 있는 이미지 쓰기 vs AI로 새로 만들기, 자동 배경 제거 vs 사진
 * 그대로 쓰기). Was previously duplicated inline in 3 places — keep
 * here so visual treatment stays in sync.
 *
 * Active visual: blue tint background (`bg-accent-soft`) + primary
 * border + subtle ring. The active styles are unconditional (no
 * `:hover` override) so hovering an active card never makes it look
 * unselected — see the bug we hit when Tailwind v4's `hover:` variant
 * out-cascaded a stateful background.
 *
 * Inactive visual: card bg + neutral border, hover darkens border only.
 *
 * Set `dense` for the rembg-style tighter padding (used inside another
 * card body, no icon row). Default is the bigger top-level layout.
 */
export interface OptionCardProps {
  active: boolean;
  title: React.ReactNode;
  desc?: React.ReactNode;
  /** Optional left-aligned icon shown next to the title. */
  icon?: React.ReactNode;
  /** Tiny supplementary line below the description. */
  meta?: React.ReactNode;
  /** dense=true tightens padding + drops the icon row spacing — use
   * inside a Card body where the OptionCard is a sub-control. */
  dense?: boolean;
  onClick: () => void;
  className?: string;
}

export function OptionCard({
  active,
  title,
  desc,
  icon,
  meta,
  dense = false,
  onClick,
  className,
}: OptionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'text-left rounded-[10px] border transition-all cursor-pointer',
        dense ? 'p-3' : 'p-3.5',
        active
          ? 'bg-accent-soft border-primary text-accent-text shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_14%,transparent)]'
          : 'bg-card border-border hover:border-rule-strong text-foreground',
        className,
      )}
    >
      {(icon || (!dense && title)) && (
        <div className="flex items-center gap-2 mb-1.5">
          {icon && (
            <span className={active ? 'text-primary' : 'text-muted-foreground'}>
              {icon}
            </span>
          )}
          <span
            className={cn(
              'font-bold tracking-[-0.014em]',
              dense ? 'text-[13px]' : 'text-[13.5px]',
              active ? 'text-accent-text' : 'text-foreground',
            )}
          >
            {title}
          </span>
        </div>
      )}
      {dense && !icon && (
        <div
          className={cn(
            'text-[13px] font-bold tracking-[-0.014em] mb-0.5',
            active ? 'text-accent-text' : 'text-foreground',
          )}
        >
          {title}
        </div>
      )}
      {desc && (
        <p
          className={cn(
            'm-0 leading-[1.5]',
            dense ? 'text-[11.5px] mb-0' : 'text-[12px] mb-1.5',
            'text-muted-foreground',
          )}
        >
          {desc}
        </p>
      )}
      {meta && (
        <div className="text-[11px] text-muted-foreground tabular-nums">
          {meta}
        </div>
      )}
    </button>
  );
}
