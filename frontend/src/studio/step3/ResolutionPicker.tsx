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

const RES_OPTION_KEYS: ResolutionKey[] = ['448p', '480p', '720p', '1080p'];

export interface ResolutionPickerProps {
  selectedKey: ResolutionKey;
  onSelect: (key: ResolutionKey) => void;
}

export function ResolutionPicker({ selectedKey, onSelect }: ResolutionPickerProps) {
  return (
    <div className="res-grid">
      {RES_OPTION_KEYS.map((key) => {
        const r = RESOLUTION_META[key];
        return (
        <button
          key={r.key}
          className={`res-tile ${selectedKey === r.key ? 'on' : ''}`}
          onClick={() => onSelect(r.key)}
        >
          <div className="res-label" style={{ marginBottom: 2 }}>
            {r.label}
          </div>
          <div className="res-dim">
            {key} · {r.width}×{r.height}
          </div>
        </button>
        );
      })}
    </div>
  );
}
