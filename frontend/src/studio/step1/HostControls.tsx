/**
 * HostControls — temperature / image-quality / error / generate
 * button row for Step 1.
 *
 * Sits below either HostTextForm or HostReferenceUploader and
 * drives the actual "쇼호스트 만들기" click. Button disables
 * itself based on the caller-supplied `canGenerate` boolean —
 * container owns the validity rule (text mode needs 15+ chars,
 * image mode needs face ref), this component just renders.
 */

import Icon from '../Icon.jsx';
import { Button, Field, Segmented } from '../primitives.jsx';

export interface HostControlsProps {
  temperature: number;
  imageQuality: '1K' | '2K' | '4K';
  errorMsg: string | null;
  generating: boolean;
  canGenerate: boolean;
  onTemperatureChange: (v: number) => void;
  onImageQualityChange: (v: '1K' | '2K' | '4K') => void;
  onGenerate: () => void;
}

export function HostControls({
  temperature,
  imageQuality,
  errorMsg,
  generating,
  canGenerate,
  onTemperatureChange,
  onImageQualityChange,
  onGenerate,
}: HostControlsProps) {
  return (
    <>
      <hr className="hr" />

      <Field
        label="변동성"
        hint="같은 입력으로 생성해도 얼마나 다양하게 나올지 — 안정적이면 비슷한 4장, 창의적이면 제각각"
      >
        <Segmented
          value={temperature}
          onChange={onTemperatureChange}
          options={[
            { value: 0.4, label: '안정적' },
            { value: 0.7, label: '보통' },
            { value: 1.0, label: '창의적' },
          ]}
        />
      </Field>

      <Field
        label="이미지 품질"
        hint="1단계와 2단계 모두에 적용돼요 · 고화질일수록 생성 시간이 길어져요 (2K ~2배, 4K ~4배)"
      >
        <Segmented
          value={imageQuality}
          onChange={onImageQualityChange}
          options={[
            { value: '1K', label: '표준 (1K)' },
            { value: '2K', label: '고화질 (2K)' },
            { value: '4K', label: '초고화질 (4K)' },
          ]}
        />
      </Field>

      {errorMsg && (
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--danger-soft)',
            border: '1px solid var(--danger)',
            borderRadius: 'var(--r-sm)',
            color: 'var(--danger)',
            fontSize: 12,
          }}
        >
          <Icon name="alert_circle" size={13} style={{ marginRight: 6 }} />
          {errorMsg}
        </div>
      )}

      <div className="flex justify-between items-center">
        <div className="text-xs text-tertiary">
          버튼을 누르면 아래에 4개의 후보가 나타나요. 마음에 드는 걸 하나 고르세요.
        </div>
        <Button
          variant="primary"
          icon={generating ? undefined : 'sparkles'}
          onClick={onGenerate}
          disabled={generating || !canGenerate}
        >
          {generating ? (
            <>
              <span className="spinner" /> 만드는 중…
            </>
          ) : (
            '쇼호스트 만들기'
          )}
        </Button>
      </div>
    </>
  );
}
