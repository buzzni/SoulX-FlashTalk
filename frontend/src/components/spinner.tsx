import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Spinner — single source of truth for loading indicators.
 *
 * Replaces the scattered `.spinner` div + WizardButton spinner + custom
 * inline rotating circles across the codebase. Consistent stroke·color·
 * motion. Defaults to `currentColor` so it inherits parent text color
 * (works inside primary button, inside ink text, inside accent badge).
 *
 * Sizes: xs (12px), sm (14px), md (16px), lg (24px). Default `sm`.
 */
export interface SpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** Optional descriptive label for screen readers (default: "불러오는 중") */
  label?: string;
}

const SIZE_PX: Record<NonNullable<SpinnerProps['size']>, number> = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 24,
};

export function Spinner({ size = 'sm', label = '불러오는 중', className, ...rest }: SpinnerProps) {
  const px = SIZE_PX[size];
  return (
    <div
      role="status"
      aria-label={label}
      className={cn('inline-block', className)}
      style={{ width: px, height: px }}
      {...rest}
    >
      <svg
        width={px}
        height={px}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="block animate-spin"
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="2.5"
          opacity="0.18"
        />
        <path
          d="M22 12a10 10 0 0 1-10 10"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
