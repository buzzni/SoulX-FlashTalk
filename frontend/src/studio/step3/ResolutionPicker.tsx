/**
 * ResolutionPicker — 4-tile video-quality picker.
 *
 * Tiles render as a grid of cards (label / dimensions / file-size
 * estimate / speed hint). Selected state flips the `.on` class on
 * the wrapper; CSS handles the highlight.
 */

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

export const RES_OPTIONS: ResolutionPreset[] = [
  { key: '448p', label: '보통 화질', tag: '448p', width: 448, height: 768, size: '약 8MB', speed: '가장 빠름', default: true },
  { key: '480p', label: '기본 화질', tag: '480p', width: 480, height: 832, size: '약 14MB', speed: '빠름' },
  { key: '720p', label: '고화질(HD)', tag: '720p', width: 720, height: 1280, size: '약 28MB', speed: '보통' },
  { key: '1080p', label: '최고 화질(FHD)', tag: '1080p', width: 1080, height: 1920, size: '약 62MB', speed: '느림' },
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
          onClick={() => onSelect({ ...r })}
        >
          <div className="res-label" style={{ marginBottom: 6 }}>
            {r.label}
          </div>
          <div className="res-dim">
            {r.tag} · {r.width}×{r.height}
          </div>
          <div className="res-meta">
            <span>용량 {r.size}</span>
            <span>{r.speed}</span>
          </div>
        </button>
      ))}
    </div>
  );
}
