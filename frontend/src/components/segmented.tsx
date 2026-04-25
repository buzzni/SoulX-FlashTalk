import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group';
import Icon from '@/studio/Icon.jsx';

/**
 * Segmented — single-select pill bar. Wraps shadcn ToggleGroup with the
 * wizard's enclosed-pill look (muted track, active item lifts to card
 * background). Coerces values back to their original type (number vs
 * string) so consumers don't have to stringify.
 *
 * `icon` accepts either a string (looked up against studio/Icon.jsx) or
 * a React element. The string form keeps existing wizard call sites terse.
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
        if (!v) return; // Don't allow empty (preserve single-select contract)
        const match = options.find((o) => String(o.value) === v);
        if (match) onChange(match.value);
      }}
      variant="outline"
      size="sm"
      className={cn('bg-muted/50 p-0.5 rounded-md', className)}
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={String(o.value)}
          value={String(o.value)}
          className="data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm text-muted-foreground border-0 h-7 px-3 text-[13px]"
        >
          {typeof o.icon === 'string' ? <Icon name={o.icon} size={13} /> : o.icon}
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
