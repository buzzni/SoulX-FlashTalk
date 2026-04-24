/**
 * HostVariantGrid — 4-tile display for host candidates (Step 1).
 *
 * Three tile flavors keyed off the richer variant shape returned by
 * `useHostGeneration`:
 *   - placeholder (mid-stream, pre-candidate) → spinner tile
 *   - error (per-slot backend failure)         → red fail tile
 *   - complete (has url)                       → clickable preview
 *
 * Selection state is lifted to the parent via `selectedSeed` + the
 * onSelect callback; this component stays pure so the same grid
 * can render in both the wizard and (future) a "pick from history"
 * view.
 */

import Icon from '../Icon.jsx';
import type { HostVariant } from '../../hooks/useHostGeneration';

export interface HostVariantGridProps {
  variants: HostVariant[];
  selectedSeed: number | null;
  onSelect: (variant: HostVariant) => void;
}

export function HostVariantGrid({ variants, selectedSeed, onSelect }: HostVariantGridProps) {
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
          color: 'var(--text-tertiary)',
          fontSize: 11,
        }}
      >
        <span className="spinner" style={{ width: 18, height: 18 }} />
      </div>
      <div className="name text-tertiary">후보 {index + 1}</div>
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
      <div className="name text-tertiary">후보 {index + 1}</div>
    </div>
  );
}

function PickableTile({
  variant,
  index,
  selected,
  onSelect,
}: {
  variant: HostVariant;
  index: number;
  selected: boolean;
  onSelect: (v: HostVariant) => void;
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
          background: variant.url ? '#0b0d12' : variant._gradient ?? undefined,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {variant.url ? (
          <img
            src={variant.url}
            alt={`후보 ${index + 1}`}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: '60%',
              background: `radial-gradient(ellipse 60% 80% at 50% 100%, oklch(0.85 0.03 60 / 0.8), transparent 70%)`,
            }}
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
      <div className="name">후보 {index + 1}</div>
    </button>
  );
}
