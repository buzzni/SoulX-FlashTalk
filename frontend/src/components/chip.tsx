import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Chip — pill-shaped toggle button. shadcn ships Toggle (rectangular) but
 * the wizard's chip language is round/pill. Tokens (primary, border, etc.)
 * come from the global design system.
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
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] cursor-pointer transition-colors',
        'border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        on
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-card text-muted-foreground border-border hover:border-input hover:text-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
