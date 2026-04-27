import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group';
import Icon from '@/studio/Icon.jsx';

/**
 * Segmented — single-select pill bar.
 *
 * Korean Productivity 결: enclosed track (sunken bg) + active item lifts
 * to white card with soft shadow. Like iOS segmented control. Slightly
 * heavier weight + tighter spacing for B aesthetic.
 */
export interface SegmentedOption<V extends string | number> {
  value: V;
  label: React.ReactNode;
  /** Icon name from studio/Icon.jsx OR a React element. */
  icon?: string | React.ReactNode;
}

export interface SegmentedProps<V extends string | number> {
  options: SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  className?: string;
}

export function Segmented<V extends string | number>({
  options,
  value,
  onChange,
  className,
}: SegmentedProps<V>) {
  return (
    <ToggleGroup
      type="single"
      value={String(value)}
      onValueChange={(v) => {
        if (!v) return;
        const match = options.find((o) => String(o.value) === v);
        if (match) onChange(match.value);
      }}
      // variant="default" (no per-item border). The outline variant +
      // spacing=0 default would inject `first:border-l` on item 1, which
      // showed up as a stray left border inside our enclosed track.
      variant="default"
      // spacing=1 also disables `data-[spacing=0]:rounded-none/border-l*`
      // selectors, so the per-item rounding + border-l overrides never
      // fire — defense-in-depth.
      spacing={1}
      size="sm"
      className={cn(
        'bg-secondary border border-border p-1 rounded-[8px] gap-0.5',
        className,
      )}
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={String(o.value)}
          value={String(o.value)}
          className="data-[state=on]:bg-card data-[state=on]:hover:bg-card data-[state=on]:text-foreground data-[state=on]:font-semibold data-[state=on]:shadow-[0_1px_2px_rgba(0,0,0,0.06),0_1px_0_rgba(0,0,0,0.04)] data-[state=on]:hover:shadow-[0_1px_2px_rgba(0,0,0,0.06),0_1px_0_rgba(0,0,0,0.04)] text-ink-2 data-[state=off]:hover:text-foreground data-[state=off]:hover:bg-transparent h-8 px-3.5 text-sm-tight font-medium rounded-[6px] bg-transparent transition-all"
        >
          {typeof o.icon === 'string' ? <Icon name={o.icon} size={13} /> : o.icon}
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
