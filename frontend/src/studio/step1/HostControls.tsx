/**
 * HostControls — temperature / image-quality / error / generate
 * button row for Step 1.
 *
 * Sits below either HostTextForm or HostReferenceUploader and drives
 * the actual "쇼호스트 만들기" click. Temperature reads/writes through
 * `useFormContext` (form state); imageQuality stays on top-level
 * wizard state (not inside the host slice). The `canGenerate` boolean
 * comes from the container, which derives validity from form values.
 */

import { Controller, useFormContext } from 'react-hook-form';
import Icon from '../Icon.jsx';
import { Field } from '@/components/field';
import { Segmented } from '@/components/segmented';
import { Sparkles } from 'lucide-react';
import type { ImageQuality } from '@/wizard/schema';
import type { HostFormValues } from '@/wizard/form-mappers';

export interface HostControlsProps {
  imageQuality: ImageQuality;
  errorMsg: string | null;
  generating: boolean;
  canGenerate: boolean;
  onImageQualityChange: (v: ImageQuality) => void;
  onGenerate: () => void;
}

export function HostControls({
  imageQuality,
  errorMsg,
  generating,
  canGenerate,
  onImageQualityChange,
  onGenerate,
}: HostControlsProps) {
  const { control } = useFormContext<HostFormValues>();
  return (
    <>
      <hr className="hr" />

      <Field
        label="변동성"
        hint="같은 입력으로 생성해도 얼마나 다양하게 나올지 — 안정적이면 비슷한 4장, 창의적이면 제각각"
      >
        <Controller
          control={control}
          name="temperature"
          render={({ field }) => (
            <Segmented
              value={field.value as number}
              onChange={field.onChange}
              options={[
                { value: 0.4, label: '안정적' },
                { value: 0.7, label: '보통' },
                { value: 1.0, label: '창의적' },
              ]}
            />
          )}
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

      <div className="flex justify-between items-center gap-3 pt-1">
        <div className="text-[12.5px] text-muted-foreground">
          버튼을 누르면 아래에 4개의 후보가 나타나요. 마음에 드는 걸 하나 고르세요.
        </div>
        <button
          type="button"
          onClick={onGenerate}
          disabled={generating || !canGenerate}
          className="inline-flex items-center gap-2 h-10 px-5 rounded-md bg-primary text-primary-foreground text-[13.5px] font-bold hover:bg-[var(--primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          {generating ? (
            <>
              <span className="spinner" /> 만드는 중
            </>
          ) : (
            <>
              <Sparkles className="size-4" />
              <span>쇼호스트 만들기</span>
            </>
          )}
        </button>
      </div>
    </>
  );
}
