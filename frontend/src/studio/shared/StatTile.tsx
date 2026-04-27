/**
 * StatTile — labelled stat block used in render/result summary rows.
 *
 * 3-tile grid pattern (걸린 시간 / 파일 용량 / 파일 형식 etc.) duplicated
 * across RenderStats, ResultStats, and ResultPage. Same vertical
 * structure: uppercase label → big value (mono optional) → small sub.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface StatTileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Use tabular-nums + JetBrains Mono for the value (durations, IDs). */
  mono?: boolean;
}

export function StatTile({ label, value, sub, mono }: StatTileProps) {
  return (
    <div className="p-3 bg-secondary rounded-md">
      <div className="text-2xs uppercase tracking-widest font-semibold text-muted-foreground">
        {label}
      </div>
      <div className={cn('text-base font-semibold', mono && 'num mono')}>{value}</div>
      {sub && <div className="text-xs text-tertiary mt-0.5">{sub}</div>}
    </div>
  );
}
