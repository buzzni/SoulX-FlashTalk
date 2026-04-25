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
  // imageId is the canonical selection key; fall back to deriving it
  // from `path` so variants persisted before the imageId field existed
  // (or rehydrated without it) still highlight correctly on click.
  const idOf = (v: HostVariant): string | null =>
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
      className={`preset-tile ${selected ? 'on' : ''}`}
      onClick={() => onSelect(variant)}
      style={{
        padding: 0,
        // Subtle dashed border on the prev tile so the slot reads
        // as "carried over" rather than "fresh candidate".
        ...(isPrev && !selected
          ? { borderStyle: 'dashed', borderColor: 'var(--border-strong, #4b5563)' }
          : null),
      }}
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
            alt={label}
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
