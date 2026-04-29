/**
 * HostVariantGrid — tile picker for host candidates (Step 1).
 *
 * Renders the 4 current candidates plus an optional 5th "이전 선택"
 * tile for the previous batch's selected image (carried over by the
 * lifecycle layer so users can revert without re-running). The prev
 * tile is functionally identical (clickable, can be the active
 * selection) but visually labeled to set expectations.
 *
 * Three tile flavors keyed off the variant shape:
 *   - placeholder (mid-stream, pre-candidate) → spinner tile
 *   - error (per-slot backend failure)         → red fail tile
 *   - complete (has url)                       → clickable preview
 *
 * Selection identifies by `imageId` (filename stem) — seed-based
 * matching collides across regenerates with random seeds.
 */

import Icon from '../Icon.jsx';
import { imageIdFromPath } from '../../api/mapping';
import { Spinner } from '@/components/spinner';
import { cn } from '@/lib/utils';
import type { HostVariant } from '../../hooks/useHostGeneration';

export interface HostVariantGridProps {
  variants: HostVariant[];
  /** Optional 5th tile (lifecycle prev_selected) — appended after the 4. */
  prevSelected: HostVariant | null;
  /** Currently-selected image_id (server-stable filename stem). Either
   * a value from the current 4 or the prev_selected tile. */
  selectedImageId: string | null;
  onSelect: (variant: HostVariant) => void;
}

export function HostVariantGrid({
  variants,
  prevSelected,
  selectedImageId,
  onSelect,
}: HostVariantGridProps) {
  const cols = prevSelected ? 5 : 4;
  // Fall back to path-derived id for variants persisted before the imageId field existed.
  const idOf = (v: HostVariant): string | null =>
    v.imageId ?? imageIdFromPath(v.key);
  const prevId = prevSelected ? idOf(prevSelected) : null;
  return (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {variants.map((v, i) => {
        if (v.placeholder) return <PlaceholderTile key={v.id} index={i} />;
        if (v.error) return <ErrorTile key={v.id} index={i} />;
        const id = idOf(v);
        return (
          <PickableTile
            key={v.id}
            variant={v}
            label={`후보 ${i + 1}`}
            selected={!!id && selectedImageId === id}
            onSelect={onSelect}
          />
        );
      })}
      {prevSelected && (
        <PickableTile
          key={prevSelected.id}
          variant={prevSelected}
          label="이전 선택"
          selected={!!prevId && selectedImageId === prevId}
          onSelect={onSelect}
          isPrev
        />
      )}
    </div>
  );
}

// Shared tile chrome — outer border + bg + hover/active visuals migrated
// from `.preset-tile`/`.preset-tile.on`/`.preset-tile .name`/`.swatch` BEM.
const TILE_BASE =
  'block p-0 rounded-md border border-border bg-card overflow-hidden transition-[border-color,box-shadow,transform] duration-150 relative';
const TILE_NAME =
  'block px-2.5 py-2 text-xs font-medium text-ink-2 text-left border-t border-border';
const TILE_NAME_ACTIVE =
  'text-foreground font-bold bg-primary-soft';
const SWATCH_BASE =
  'aspect-[9/16] bg-secondary flex items-center justify-center';

function PlaceholderTile({ index }: { index: number }) {
  return (
    <div className={cn(TILE_BASE, 'cursor-default')}>
      <div className={cn(SWATCH_BASE, 'skeleton-shimmer relative grid place-items-center text-muted-foreground text-2xs')}>
        <Spinner size="md" />
      </div>
      <div className={cn(TILE_NAME, 'text-muted-foreground')}>후보 {index + 1}</div>
    </div>
  );
}

function ErrorTile({ index }: { index: number }) {
  return (
    <div className={cn(TILE_BASE, 'cursor-default border-destructive')}>
      <div className={cn(SWATCH_BASE, 'grid place-items-center text-destructive text-center bg-destructive-soft text-2xs p-1.5')}>
        <div>
          <Icon name="alert_circle" size={16} />
          <div className="mt-1">실패</div>
        </div>
      </div>
      <div className={cn(TILE_NAME, 'text-muted-foreground')}>후보 {index + 1}</div>
    </div>
  );
}

function PickableTile({
  variant,
  label,
  selected,
  onSelect,
  isPrev = false,
}: {
  variant: HostVariant;
  label: string;
  selected: boolean;
  onSelect: (v: HostVariant) => void;
  isPrev?: boolean;
}) {
  return (
    <button
      className={cn(
        TILE_BASE,
        'cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2',
        // Hover lift only when not active and not prev.
        !selected && !isPrev && 'hover:border-rule-strong hover:-translate-y-px hover:shadow-sm',
        selected &&
          'border-primary -translate-y-px shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_18%,transparent),var(--shadow-1)]',
        // Subtle dashed border on the prev tile so the slot reads as
        // "carried over" rather than "fresh candidate".
        isPrev && !selected && 'border-dashed border-rule-strong',
      )}
      onClick={() => onSelect(variant)}
      style={variant._gradient && !variant.url ? { background: variant._gradient } : undefined}
    >
      <div
        className={cn(SWATCH_BASE, 'relative overflow-hidden')}
        style={{ background: variant.url ? '#0b0d12' : undefined }}
      >
        {variant.url ? (
          <img src={variant.url} alt={label} className="w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-x-0 bottom-0 h-[60%] bg-[radial-gradient(ellipse_60%_80%_at_50%_100%,oklch(0.85_0.03_60_/_0.8),transparent_70%)]" />
        )}
        {selected && (
          <div className="absolute top-1.5 right-1.5 grid place-items-center w-5 h-5 rounded-full bg-primary text-white">
            <Icon name="check" size={12} />
          </div>
        )}
        {isPrev && (
          <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-[4px] bg-black/55 text-white text-2xs tracking-[0.2px]">
            이전
          </div>
        )}
      </div>
      <div className={cn(TILE_NAME, selected && TILE_NAME_ACTIVE)}>{label}</div>
    </button>
  );
}
