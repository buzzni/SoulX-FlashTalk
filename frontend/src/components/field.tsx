import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Field — label + optional hint + child control. Used for wizard form rows
 * where shadcn's Label primitive alone isn't enough (we want the hint sitting
 * on the right side of the label baseline).
 */
export interface FieldProps {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function Field({ label, hint, className, children }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label className="flex items-center justify-between text-[12px] font-medium text-foreground/80">
          <span>{label}</span>
          {hint && <span className="text-muted-foreground font-normal">{hint}</span>}
        </label>
      )}
      {children}
    </div>
  );
}
