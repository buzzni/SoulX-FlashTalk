/**
 * HostTextForm — text-mode inputs for Step 1.
 *
 * Free-text prompt + category-builder chips + optional negative
 * prompt. Everything the "설명으로 만들기" tab shows, minus the
 * generation button (container owns that).
 */

import { Chip } from '@/components/chip';
import { Field } from '@/components/field';
const HOST_PRESETS: Record<string, { value: string; label: string }[]> = {
  성별: [
    { value: 'female', label: '여성' },
    { value: 'male', label: '남성' },
  ],
  연령대: [
    { value: '20s', label: '20대 · 젊고 밝은' },
    { value: '30s', label: '30대 · 친근한' },
    { value: '40s', label: '40대 · 신뢰감 있는' },
    { value: '50plus', label: '50대+ · 따뜻한' },
  ],
  분위기: [
    { value: 'bright', label: '밝고 활기찬' },
    { value: 'calm', label: '차분하고 신뢰감' },
    { value: 'friendly', label: '친근하고 편안' },
    { value: 'pro', label: '전문적이고 세련' },
  ],
  옷차림: [
    { value: 'formal', label: '정장' },
    { value: 'casual', label: '캐주얼' },
    { value: 'chic', label: '세련된 모던' },
    { value: 'cozy', label: '편안한 홈웨어' },
  ],
};

const EXAMPLE_PROMPTS = [
  '30대 여성, 밝게 웃고 있음, 베이지 니트, 따뜻한 분위기',
  '20대 여성, 활기찬 표정, 화이트 블라우스, 깔끔한 스튜디오',
  '40대 남성, 차분하고 신뢰감 있는 표정, 네이비 셔츠',
];

export interface HostTextFormProps {
  prompt: string;
  negativePrompt: string;
  builder: Record<string, string>;
  onPromptChange: (s: string) => void;
  onNegativePromptChange: (s: string) => void;
  onBuilderChange: (b: Record<string, string>) => void;
}

export function HostTextForm({
  prompt,
  negativePrompt,
  builder,
  onPromptChange,
  onNegativePromptChange,
  onBuilderChange,
}: HostTextFormProps) {
  return (
    <div className="flex-col gap-3">
      <Field label="어떤 모습의 쇼호스트를 원하세요?" hint="자유롭게 15자 이상">
        <textarea
          className={`textarea ${prompt && prompt.length < 15 ? 'invalid' : ''}`}
          placeholder="예) 30대 여성, 밝게 웃고 있음, 베이지 니트, 따뜻한 분위기"
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          <span className="text-xs text-tertiary" style={{ alignSelf: 'center' }}>
            예시 클릭 →
          </span>
          {EXAMPLE_PROMPTS.map((ex) => (
            <Chip key={ex} onClick={() => onPromptChange(ex)}>
              {ex.split(',')[0]}
            </Chip>
          ))}
        </div>
      </Field>

      <div>
        <div className="field-label" style={{ marginBottom: 10, marginTop: 6 }}>
          또는 조건으로 선택해요
        </div>
        <div className="flex-col gap-3">
          {Object.keys(HOST_PRESETS).map((key) => (
            <div key={key}>
              <div className="text-xs text-tertiary" style={{ marginBottom: 6 }}>
                {key}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {HOST_PRESETS[key]!.map((o) => (
                  <Chip
                    key={o.value}
                    on={builder?.[key] === o.value}
                    onClick={() => onBuilderChange({ ...builder, [key]: o.value })}
                  >
                    {o.label}
                  </Chip>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <details style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
        <summary style={{ cursor: 'pointer', userSelect: 'none' }}>
          피하고 싶은 표현이 있나요? (선택)
        </summary>
        <input
          className="input mt-2"
          placeholder="예) 과한 화장, 어두운 표정"
          value={negativePrompt}
          onChange={(e) => onNegativePromptChange(e.target.value)}
        />
      </details>
    </div>
  );
}
