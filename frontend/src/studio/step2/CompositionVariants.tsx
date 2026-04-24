/**
 * CompositionVariants — 4-tile display for composite candidates.
 *
 * Identical tile shape to HostVariantGrid (placeholder spinner /
 * error tile / pickable preview with selected check) — Phase 4g's
 * shared-primitives extraction will fold both into one
 * `VariantGrid` with a label prefix prop. For now they're twins.
 */

import Icon from '../Icon.jsx';
import type { CompositionVariant } from '../../hooks/useCompositeGeneration';

export interface CompositionVariantsProps {
  variants: CompositionVariant[];
  selectedSeed: number | null;
  onSelect: (v: CompositionVariant) => void;
}

export function CompositionVariants({
  variants,
  selectedSeed,
  onSelect,
}: CompositionVariantsProps) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
      {variants.map((v, i) => {
        if (v.placeholder) return <PlaceholderTile key={v.id} index={i} />;
        if (v.error) return <ErrorTile key={v.id} index={i} />;
        return (
          <PickableTile
            key={v.id}
            variant={v}
            index={i}
            selected={selectedSeed === v.seed}
            onSelect={onSelect}
          />
        );
      })}
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
  index,
  selected,
  onSelect,
}: {
  variant: CompositionVariant;
  index: number;
  selected: boolean;
  onSelect: (v: CompositionVariant) => void;
}) {
  return (
    <button
      className={`preset-tile ${selected ? 'on' : ''}`}
      onClick={() => onSelect(variant)}
      style={{ padding: 0 }}
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
            alt={`합성 후보 ${index + 1}`}
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
      </div>
      <div className="name">합성 {index + 1}</div>
    </button>
  );
}
