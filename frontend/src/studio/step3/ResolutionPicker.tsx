/**
 * ResolutionPicker — 4-tile video-quality picker.
 *
 * Compact tile: label · dimensions · time hint · file size. The 4K tile
 * gets an amber color on the time hint to flag the cost.
 */
import { Clock } from 'lucide-react';

export interface ResolutionPreset {
  key: string;
  label: string;
  tag: string;
  width: number;
  height: number;
  size: string;
  speed: string;
  default?: boolean;
}

export const RES_OPTIONS: (ResolutionPreset & { time: string; warn?: boolean })[] = [
  { key: '448p', label: '보통 화질', tag: '448p', width: 448, height: 768, size: '약 8MB', speed: '가장 빠름', time: '~30초', default: true },
  { key: '480p', label: '기본 화질', tag: '480p', width: 480, height: 832, size: '약 14MB', speed: '빠름', time: '~35초' },
  { key: '720p', label: '고화질(HD)', tag: '720p', width: 720, height: 1280, size: '약 28MB', speed: '보통', time: '~1분' },
  { key: '1080p', label: '최고 화질(FHD)', tag: '1080p', width: 1080, height: 1920, size: '약 62MB', speed: '느림', time: '~2분', warn: true },
];

export interface ResolutionPickerProps {
  selectedKey: string;
  onSelect: (preset: ResolutionPreset) => void;
}

export function ResolutionPicker({ selectedKey, onSelect }: ResolutionPickerProps) {
  return (
    <div className="res-grid">
      {RES_OPTIONS.map((r) => (
        <button
          key={r.key}
          className={`res-tile ${selectedKey === r.key ? 'on' : ''}`}
          onClick={() =>
            onSelect({
              key: r.key, label: r.label, tag: r.tag,
              width: r.width, height: r.height, size: r.size, speed: r.speed,
              default: r.default,
            })
          }
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
      ))}
    </div>
  );
}
