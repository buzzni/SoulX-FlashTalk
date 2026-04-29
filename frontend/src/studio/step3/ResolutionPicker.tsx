/**
 * ResolutionPicker — 4-tile video-quality picker.
 *
 * Emits a `ResolutionKey` string only — full meta
 * (width/height/label) is derived via `resolutionMeta(key)` from
 * wizard/schema so consumers don't copy-paste an object already in the
 * canonical table.
 */
import type { ResolutionKey } from '@/wizard/schema';
import { RESOLUTION_META } from '@/wizard/schema';
import { cn } from '@/lib/utils';

const RES_OPTION_KEYS: ResolutionKey[] = ['448p', '480p', '720p', '1080p'];

export interface ResolutionPickerProps {
  selectedKey: ResolutionKey;
  onSelect: (key: ResolutionKey) => void;
}

export function ResolutionPicker({ selectedKey, onSelect }: ResolutionPickerProps) {
  return (
    <div className="grid grid-cols-4 gap-2.5">
      {RES_OPTION_KEYS.map((key) => {
        const r = RESOLUTION_META[key];
        const on = selectedKey === r.key;
        return (
          <button
            key={r.key}
            onClick={() => onSelect(r.key)}
            className={cn(
              'relative px-3.5 py-4 rounded-md border bg-card text-left transition-[border-color,box-shadow,transform,background-color] duration-150',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2',
              on
                ? 'border-primary bg-primary-soft -translate-y-px shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_16%,transparent)]'
                : 'border-border hover:border-rule-strong hover:-translate-y-px hover:shadow-sm',
            )}
          >
            <div
              className={cn(
                'mb-0.5 text-sm font-bold tracking-tight',
                on && 'text-primary-on-soft',
              )}
            >
              {r.label}
            </div>
            <div
              className={cn(
                'text-[11px] mt-0.5 font-mono',
                on ? 'text-primary-on-soft/75' : 'text-muted-foreground',
              )}
            >
              {key} · {r.width}×{r.height}
            </div>
          </button>
        );
      })}
    </div>
  );
}
