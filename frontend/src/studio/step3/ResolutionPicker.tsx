/**
 * ResolutionPicker — 4-tile video-quality picker.
 *
 * Emits a `ResolutionKey` string only — full meta
 * (width/height/size/speed/label) is derived via `resolutionMeta(key)`
 * from wizard/schema so consumers don't copy-paste an object already
 * in the canonical table.
 */
import { Clock } from 'lucide-react';
import type { ResolutionKey } from '@/wizard/schema';
import { RESOLUTION_META } from '@/wizard/schema';

const RES_DISPLAY: Record<ResolutionKey, { time: string; warn?: boolean }> = {
  '448p': { time: '~30초' },
  '480p': { time: '~35초' },
  '720p': { time: '~1분' },
  '1080p': { time: '~2분', warn: true },
};

const RES_OPTION_KEYS: ResolutionKey[] = ['448p', '480p', '720p', '1080p'];

export interface ResolutionPickerProps {
  selectedKey: ResolutionKey;
  onSelect: (key: ResolutionKey) => void;
}

export function ResolutionPicker({ selectedKey, onSelect }: ResolutionPickerProps) {
  return (
    <div className="res-grid">
      {RES_OPTION_KEYS.map((key) => {
        const r = { ...RESOLUTION_META[key], ...RES_DISPLAY[key], tag: key };
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
            {r.tag} · {r.width}×{r.height}
          </div>
          <div className="res-meta" style={{ marginTop: 10 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: r.warn ? 600 : 500, color: r.warn ? 'var(--warn-text)' : undefined }}>
              <Clock style={{ width: 11, height: 11 }} />
              {r.time}
            </span>
            <span>{r.size}</span>
          </div>
        </button>
        );
      })}
    </div>
  );
}
