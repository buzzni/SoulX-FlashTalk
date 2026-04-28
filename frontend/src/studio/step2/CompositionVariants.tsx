/**
 * CompositionVariants — tile picker for composite candidates (Step 2).
 *
 * 4 fresh candidates plus an optional 5th "이전 선택" tile sourced
 * from the lifecycle prev_selected slot. Mirror of HostVariantGrid;
 * Phase 4g may fold both into one shared VariantGrid.
 */

import Icon from '../Icon.jsx';
import { imageIdFromPath } from '../../api/mapping';
import { Spinner } from '@/components/spinner';
import { cn } from '@/lib/utils';
import type { CompositionVariant } from '../../hooks/useCompositeGeneration';

export interface CompositionVariantsProps {
  variants: CompositionVariant[];
  prevSelected: CompositionVariant | null;
  selectedImageId: string | null;
  onSelect: (v: CompositionVariant) => void;
}

export function CompositionVariants({
  variants,
  prevSelected,
  selectedImageId,
  onSelect,
}: CompositionVariantsProps) {
  const cols = prevSelected ? 5 : 4;
  const idOf = (v: CompositionVariant): string | null =>
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
            label={`합성 ${i + 1}`}
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

// Mirror of HostVariantGrid's tile chrome — see that file's header for
// the BEM-to-utility migration rationale.
const TILE_BASE =
  'block p-0 rounded-md border border-border bg-card overflow-hidden transition-[border-color,box-shadow,transform] duration-150 relative';
const TILE_NAME =
  'block px-2.5 py-2 text-xs font-medium text-ink-2 text-left border-t border-border';
const TILE_NAME_ACTIVE = 'text-foreground font-bold bg-primary-soft';
const SWATCH_BASE = 'aspect-[9/16] bg-secondary flex items-center justify-center';

function PlaceholderTile({ index }: { index: number }) {
  return (
    <div className={cn(TILE_BASE, 'cursor-default')}>
      <div className={cn(SWATCH_BASE, 'skeleton-shimmer relative grid place-items-center')}>
        <Spinner size="md" />
      </div>
      <div className={cn(TILE_NAME, 'text-muted-foreground')}>합성 {index + 1}</div>
    </div>
  );
}

function ErrorTile({ index }: { index: number }) {
  return (
    <div className={cn(TILE_BASE, 'cursor-default border-destructive')}>
      <div className={cn(SWATCH_BASE, 'grid place-items-center text-destructive bg-destructive-soft text-center text-2xs p-1.5')}>
        <div>
          <Icon name="alert_circle" size={16} />
          <div className="mt-1">실패</div>
        </div>
      </div>
      <div className={cn(TILE_NAME, 'text-muted-foreground')}>합성 {index + 1}</div>
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
  variant: CompositionVariant;
  label: string;
  selected: boolean;
  onSelect: (v: CompositionVariant) => void;
  isPrev?: boolean;
}) {
  return (
    <button
      className={cn(
        TILE_BASE,
        'cursor-pointer',
        !selected && !isPrev && 'hover:border-rule-strong hover:-translate-y-px hover:shadow-sm',
        selected &&
          'border-primary -translate-y-px shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_18%,transparent),var(--shadow-1)]',
        isPrev && !selected && 'border-dashed border-rule-strong',
      )}
      onClick={() => onSelect(variant)}
    >
      <div className={cn(SWATCH_BASE, 'relative overflow-hidden bg-[#0b0d12]')}>
        {variant.url && (
          <img src={variant.url} alt={label} className="w-full h-full object-cover" />
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
