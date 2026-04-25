/**
 * CompositionVariants — tile picker for composite candidates (Step 2).
 *
 * 4 fresh candidates plus an optional 5th "이전 선택" tile sourced
 * from the lifecycle prev_selected slot. Mirror of HostVariantGrid;
 * Phase 4g may fold both into one shared VariantGrid.
 */

import Icon from '../Icon.jsx';
import { imageIdFromPath } from '../../api/mapping';
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
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 10 }}>
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
          selected={(() => {
            const id = idOf(prevSelected);
            return !!id && selectedImageId === id;
          })()}
          onSelect={onSelect}
          isPrev
        />
      )}
    </div>
  );
}

function PlaceholderTile({ index }: { index: number }) {
  return (
    <div className="preset-tile" style={{ padding: 0, cursor: 'default' }}>
      <div
        className="swatch skeleton-shimmer"
        style={{
          aspectRatio: '9/16',
          position: 'relative',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <span className="spinner" style={{ width: 18, height: 18 }} />
      </div>
      <div className="name text-tertiary">합성 {index + 1}</div>
    </div>
  );
}

function ErrorTile({ index }: { index: number }) {
  return (
    <div
      className="preset-tile"
      style={{ padding: 0, cursor: 'default', borderColor: 'var(--danger)' }}
    >
      <div
        className="swatch"
        style={{
          aspectRatio: '9/16',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--danger)',
          fontSize: 10,
          textAlign: 'center',
          padding: 6,
          background: 'var(--danger-soft)',
        }}
      >
        <div>
          <Icon name="alert_circle" size={16} />
          <div style={{ marginTop: 4 }}>실패</div>
        </div>
      </div>
      <div className="name text-tertiary">합성 {index + 1}</div>
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
      className={`preset-tile ${selected ? 'on' : ''}`}
      onClick={() => onSelect(variant)}
      style={{
        padding: 0,
        ...(isPrev && !selected
          ? { borderStyle: 'dashed', borderColor: 'var(--border-strong, #4b5563)' }
          : null),
      }}
    >
      <div
        className="swatch"
        style={{
          aspectRatio: '9/16',
          background: '#0b0d12',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {variant.url && (
          <img
            src={variant.url}
            alt={label}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
        {selected && (
          <div
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              background: 'var(--accent)',
              color: '#fff',
              borderRadius: 99,
              width: 20,
              height: 20,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <Icon name="check" size={12} />
          </div>
        )}
        {isPrev && (
          <div
            style={{
              position: 'absolute',
              top: 6,
              left: 6,
              background: 'rgba(0,0,0,0.55)',
              color: '#fff',
              borderRadius: 4,
              padding: '2px 6px',
              fontSize: 10,
              letterSpacing: 0.2,
            }}
          >
            이전
          </div>
        )}
      </div>
      <div className="name">{label}</div>
    </button>
  );
}
