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
    v.imageId ?? imageIdFromPath(v.path);
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

function PlaceholderTile({ index }: { index: number }) {
  return (
    <div className="preset-tile p-0 cursor-default">
      <div className="swatch skeleton-shimmer relative grid place-items-center text-tertiary text-2xs aspect-[9/16]">
        <Spinner size="md" />
      </div>
      <div className="name text-tertiary">후보 {index + 1}</div>
    </div>
  );
}

function ErrorTile({ index }: { index: number }) {
  return (
    <div className="preset-tile p-0 cursor-default border-destructive">
      <div className="swatch grid place-items-center text-destructive text-center bg-destructive-soft text-2xs p-1.5 aspect-[9/16]">
        <div>
          <Icon name="alert_circle" size={16} />
          <div className="mt-1">실패</div>
        </div>
      </div>
      <div className="name text-tertiary">후보 {index + 1}</div>
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
        'preset-tile p-0',
        selected && 'on',
        // Subtle dashed border on the prev tile so the slot reads as
        // "carried over" rather than "fresh candidate".
        isPrev && !selected && 'border-dashed border-rule-strong',
      )}
      onClick={() => onSelect(variant)}
      style={undefined}
    >
      <div
        className="swatch relative overflow-hidden aspect-[9/16]"
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
      <div className="name">{label}</div>
    </button>
  );
}
