import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Chip — pill-shaped toggle.
 *
 * Korean Productivity 결: inactive = soft secondary fill (not outline),
 * active = filled primary. Comfortable padding/size so chip groups feel
 * intentional rather than cramped.
 */
export interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  on?: boolean;
}

export function Chip({ on, className, children, ...props }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={!!on}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer transition-colors',
        'border focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2',
        on
          ? 'bg-primary text-primary-foreground border-primary shadow-[0_1px_0_rgba(0,93,255,0.18)]'
          : 'bg-secondary text-ink-2 border-transparent hover:bg-card hover:border-border hover:text-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
