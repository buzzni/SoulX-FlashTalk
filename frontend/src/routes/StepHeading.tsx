/**
 * StepHeading — visual hero for each wizard step.
 *
 * Big "01"/"02"/"03" badge on left + headline + caption on right + small
 * "3단계 중 N" indicator. Replaces the plain `<div className="step-heading">
 * <h1>1단계 · 쇼호스트 만들기</h1></div>` pattern that gave the wizard pages
 * weak visual entry points. Comes with optional `eyebrow` for status pills
 * (e.g. "수정 모드", "초안") and `aside` for top-right info pills.
 */
import * as React from 'react';

export interface StepHeadingProps {
  step: 1 | 2 | 3;
  total?: number;
  title: string;
  description?: string;
  eyebrow?: React.ReactNode;
  aside?: React.ReactNode;
}

export function StepHeading({
  step,
  total = 3,
  title,
  description,
  eyebrow,
  aside,
}: StepHeadingProps) {
  return (
    <div className="step-heading-hero">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 md:gap-5">
        <div
          aria-hidden
          className="grid place-items-center w-14 h-14 md:w-16 md:h-16 rounded-[12px] bg-foreground text-background font-bold tabular-nums text-[28px] tracking-tighter leading-none"
        >
          {String(step).padStart(2, '0')}
        </div>
        <div className="min-w-0">
          {eyebrow && (
            <div className="text-2xs font-semibold text-muted-foreground tracking-tight mb-0.5">
              {eyebrow}
            </div>
          )}
          <h1 className="m-0 text-foreground font-sans text-[22px] font-bold tracking-tighter leading-[1.25]">
            {title}
          </h1>
          {description && (
            <p className="m-0 mt-1 text-sm-tight text-muted-foreground">{description}</p>
          )}
        </div>
        <div className="hidden md:flex items-center gap-2">
          <div className="text-2xs text-muted-foreground tabular-nums whitespace-nowrap">
            {total}단계 중 {step}
          </div>
          {aside}
        </div>
      </div>
    </div>
  );
}
