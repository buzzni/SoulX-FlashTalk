/**
 * BackgroundPicker — background source switch for Step 2.
 *
 * Four sources: preset (grid of 8), upload (UploadTile + server
 * file picker), URL, prompt (AI-generated gradient placeholder).
 *
 * "Generate bg" is a stub that just tints with a random gradient
 * — the real backend pipeline for prompt-based background
 * generation lives in Step 2's compositor (run when the user hits
 * "합성 이미지 만들기"), not here.
 */

import Icon from '../Icon.jsx';
import { WizardButton as Button } from '@/components/wizard-button';
import { Field } from '@/components/field';
import { Segmented } from '@/components/segmented';
import { UploadTile } from '@/components/upload-tile';
export interface Background {
  source?: 'preset' | 'upload' | 'url' | 'prompt' | null;
  preset?: string | { id: string; label?: string; gradient?: string } | null;
  imageUrl?: string | null;
  url?: string;
  prompt?: string;
  uploadPath?: string | null;
  serverFilename?: string | null;
  _file?: { _file?: File; url?: string } | File | null;
  _gradient?: string | null;
}

export interface BackgroundPickerProps {
  background: Background;
  onBackgroundChange: (patch: Partial<Background>) => void;
  onPickServerFile: () => void;
}

const BG_PRESETS = [
  {
    id: 'studio_white',
    label: '깔끔한 화이트',
    desc: '어떤 제품이든 무난',
    gradient: 'linear-gradient(180deg, oklch(0.97 0.003 95), oklch(0.88 0.005 95))',
  },
  {
    id: 'studio_warm',
    label: '따뜻한 스튜디오',
    desc: '뷰티·패션',
    gradient: 'linear-gradient(180deg, oklch(0.9 0.03 60), oklch(0.7 0.05 40))',
  },
  {
    id: 'living_cozy',
    label: '아늑한 거실',
    desc: '리빙·생활용품',
    gradient: 'linear-gradient(180deg, oklch(0.75 0.04 60), oklch(0.5 0.05 40))',
  },
  {
    id: 'kitchen',
    label: '모던 주방',
    desc: '식품·주방용품',
    gradient: 'linear-gradient(180deg, oklch(0.85 0.015 230), oklch(0.6 0.02 230))',
  },
  {
    id: 'outdoor_park',
    label: '햇살 좋은 야외',
    desc: '운동·레저',
    gradient: 'linear-gradient(180deg, oklch(0.8 0.08 150), oklch(0.5 0.08 150))',
  },
  {
    id: 'night_neon',
    label: '네온 야경',
    desc: '트렌디·젊은 타겟',
    gradient: 'linear-gradient(180deg, oklch(0.35 0.1 300), oklch(0.2 0.1 260))',
  },
  {
    id: 'retail',
    label: '매장 쇼룸',
    desc: '패션·가전',
    gradient: 'linear-gradient(180deg, oklch(0.85 0.02 40), oklch(0.6 0.04 40))',
  },
  {
    id: 'solid_blue',
    label: '블루 단색',
    desc: '깔끔 강조',
    gradient: 'linear-gradient(180deg, oklch(0.55 0.15 255), oklch(0.4 0.15 255))',
  },
];

export function BackgroundPicker({
  background,
  onBackgroundChange,
  onPickServerFile,
}: BackgroundPickerProps) {
  const source = background.source ?? 'preset';
  const presetId =
    typeof background.preset === 'object' ? background.preset?.id : background.preset;

  return (
    <>
      <Segmented
        value={source}
        onChange={(v: 'preset' | 'upload' | 'url' | 'prompt') =>
          onBackgroundChange({ source: v })
        }
        options={[
          { value: 'preset', label: '추천 장소에서 고르기', icon: 'frame' },
          { value: 'upload', label: '내 사진 사용', icon: 'upload' },
          { value: 'url', label: '링크로 가져오기', icon: 'link' },
          { value: 'prompt', label: '직접 만들기', icon: 'wand' },
        ]}
      />

      <div className="mt-3">
        {source === 'preset' && (
          <div className="preset-grid">
            {BG_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`preset-tile ${presetId === p.id ? 'on' : ''}`}
                onClick={() =>
                  onBackgroundChange({
                    preset: p.id,
                    _gradient: p.gradient,
                    imageUrl: null,
                    prompt: '',
                    url: '',
                  })
                }
              >
                <div className="swatch" style={{ background: p.gradient }} />
                <div className="name">
                  <div>{p.label}</div>
                  <div
                    className="text-xs text-tertiary"
                    style={{ fontWeight: 400, marginTop: 1 }}
                  >
                    {p.desc}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {source === 'upload' && (
          <div className="flex-col gap-2">
            {background.imageUrl && background.uploadPath && !background._file ? (
              <div className="upload-tile has-file">
                <div className="file-thumb">
                  <img src={background.imageUrl} alt={background.serverFilename || ''} />
                </div>
                <div className="file-meta">
                  <span className="truncate">{background.serverFilename || '(서버 파일)'}</span>
                  <span className="mono">server</span>
                </div>
                <div className="file-buttons">
                  <button className="file-btn" onClick={onPickServerFile}>
                    <Icon name="swap" size={12} /> 다른 파일
                  </button>
                  <button
                    className="file-btn file-btn-danger"
                    onClick={() =>
                      onBackgroundChange({
                        _file: null,
                        imageUrl: null,
                        uploadPath: null,
                        serverFilename: null,
                      })
                    }
                  >
                    <Icon name="trash" size={12} /> 삭제
                  </button>
                </div>
              </div>
            ) : (
              <UploadTile
                file={background._file as { url?: string; name?: string } | null | undefined}
                onFile={(f) =>
                  onBackgroundChange({
                    _file: f,
                    imageUrl: f?.url,
                    preset: null,
                    prompt: '',
                    url: '',
                  })
                }
                onRemove={() => onBackgroundChange({ _file: null, imageUrl: null })}
                label="배경 사진 올리기"
                sub="촬영한 매장 사진 등"
              />
            )}
            <button
              type="button"
              onClick={onPickServerFile}
              className="self-start inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              <Icon name="file" size={12} /> 서버에 있는 파일에서 선택
            </button>
          </div>
        )}

        {source === 'url' && (
          <Field label="이미지 주소">
            <div className="input-group">
              <span className="prefix">
                <Icon name="link" size={12} />
              </span>
              <input
                className="input has-prefix"
                placeholder="예) https://... 로 시작하는 이미지 링크"
                value={background.url || ''}
                onChange={(e) =>
                  onBackgroundChange({
                    url: e.target.value,
                    imageUrl: null,
                    preset: null,
                    prompt: '',
                  })
                }
              />
            </div>
          </Field>
        )}

        {source === 'prompt' && (
          <div className="flex-col gap-3">
            <Field label="어떤 배경이 필요한가요?" hint="장소·분위기를 적어주세요">
              <textarea
                className="textarea"
                placeholder="예) 밝고 깨끗한 모던 주방, 큰 창문으로 자연광이 들어오는 느낌"
                value={background.prompt || ''}
                onChange={(e) => onBackgroundChange({ prompt: e.target.value })}
              />
            </Field>
            <div className="flex justify-between items-center">
              <div className="text-xs text-tertiary">
                "합성 이미지 만들기"를 누르면 이 설명으로 배경까지 같이 합성돼요.
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
