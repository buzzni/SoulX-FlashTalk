import * as React from 'react';
import { Tabs as TabsPrimitive, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/**
 * WizardTabs — pre-styled enclosed-track tabs for in-form sub-mode
 * switching (배경 source 추천/내사진/링크, 음성 source 목소리/복제/녹음).
 *
 * Same visual treatment as Segmented (sunken track, lifted card on
 * active) but wraps shadcn `Tabs` so existing TabsTrigger ARIA semantics
 * stay intact. Replaces the 5+ duplicated long className strings that
 * lived inline in BackgroundPicker / Step3Audio.
 *
 * Active hover lock: `data-[state=active]:hover:bg-card` (and matching
 * shadow) ensures Tailwind v4's hover variant doesn't out-cascade the
 * active state — same fix pattern we applied to Segmented.
 */

export interface WizardTabsProps {
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  children: React.ReactNode;
}

export function WizardTabs({
  value,
  onValueChange,
  className,
  children,
}: WizardTabsProps) {
  return (
    <TabsPrimitive value={value} onValueChange={onValueChange} className={className}>
      <TabsList className="bg-secondary border border-border p-1 h-auto rounded-md gap-0.5">
        {children}
      </TabsList>
    </TabsPrimitive>
  );
}

export interface WizardTabProps {
  value: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function WizardTab({ value, icon, children, className }: WizardTabProps) {
  return (
    <TabsTrigger
      value={value}
      className={cn(
        'data-[state=active]:bg-card data-[state=active]:hover:bg-card',
        'data-[state=active]:text-foreground',
        'data-[state=active]:font-semibold',
        "data-[state=active]:shadow-[0_1px_2px_rgba(0,0,0,0.06),0_1px_0_rgba(0,0,0,0.04)]",
        "data-[state=active]:hover:shadow-[0_1px_2px_rgba(0,0,0,0.06),0_1px_0_rgba(0,0,0,0.04)]",
        'text-ink-2 data-[state=inactive]:hover:text-foreground',
        'border-0 h-8 px-3.5 text-[13px] font-medium rounded-[6px] gap-1.5',
        className,
      )}
    >
      {icon}
      {children}
    </TabsTrigger>
  );
}
