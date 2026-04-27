/**
 * VoiceAdvancedSettings — TTS tuning sliders.
 *
 * Speed lives outside the collapsible (users tweak it often);
 * stability / style / similarity live inside a <details> because
 * most people never touch them. `voice.pitch` was cut pre-
 * refactor — not an ElevenLabs v3 param and the ffmpeg post-
 * processing pipeline to do it ourselves isn't built.
 *
 * Reads/writes through `useFormContext`. Only renders when the
 * parent narrows on `voice.source !== 'upload'` (advanced doesn't
 * exist on the upload variant), so `voice.advanced` is a valid path.
 */

import { useFormContext, useWatch } from 'react-hook-form';
import Icon from '../Icon.jsx';
import { Field } from '@/components/field';
import { WizardSlider as Slider } from '@/components/wizard-slider';
import type { VoiceAdvanced } from '@/wizard/schema';
import type { Step3FormValues } from '@/wizard/form-mappers';

export interface VoiceAdvancedSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}

export function VoiceAdvancedSettings({
  open,
  onOpenChange,
  disabled = false,
}: VoiceAdvancedSettingsProps) {
  const { control, setValue, getValues } = useFormContext<Step3FormValues>();
  const advanced = useWatch({
    control,
    name: 'voice.advanced' as const,
  }) as VoiceAdvanced | undefined;

  if (!advanced) return null;

  const set = (patch: Partial<VoiceAdvanced>) => {
    const cur = getValues('voice.advanced' as const) as VoiceAdvanced | undefined;
    if (!cur) return;
    setValue(
      'voice.advanced' as const,
      { ...cur, ...patch },
      { shouldDirty: true, shouldValidate: true },
    );
  };

  return (
    <>
      <div className="field-row mt-3">
        <Field label={`읽는 속도 · ${advanced.speed.toFixed(2)}배`} hint="0.5배 ~ 1.8배">
          <Slider
            value={advanced.speed}
            onChange={(v: number) => set({ speed: v })}
            min={0.5}
            max={1.8}
            step={0.05}
            formatValue={(v: number) => `${v.toFixed(2)}x`}
            disabled={disabled}
          />
        </Field>
      </div>

      <details
        className="mt-3"
        open={open}
        onToggle={(e) => onOpenChange((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer select-none text-xs text-ink-3 inline-flex items-center gap-1">
          <Icon name={open ? 'chevron_up' : 'chevron_down'} size={11} />
          목소리 세밀 조정 (고급, 대부분 그대로 두셔도 괜찮아요)
        </summary>
        <div className="field-row-3 mt-2.5">
          <Field
            label={`일정함 · ${Math.round(advanced.stability * 100)}`}
            hint="높을수록 톤 유지"
          >
            <Slider
              value={advanced.stability}
              onChange={(v: number) => set({ stability: v })}
              min={0}
              max={1}
              step={0.01}
              formatValue={(v: number) => String(Math.round(v * 100))}
              disabled={disabled}
            />
          </Field>
          <Field
            label={`말투 강조 · ${Math.round(advanced.style * 100)}`}
            hint="높을수록 감정 풍부"
          >
            <Slider
              value={advanced.style}
              onChange={(v: number) => set({ style: v })}
              min={0}
              max={1}
              step={0.01}
              formatValue={(v: number) => String(Math.round(v * 100))}
              disabled={disabled}
            />
          </Field>
          <Field
            label={`원본 유사도 · ${Math.round(advanced.similarity * 100)}`}
            hint="복제 모드에서만 적용"
          >
            <Slider
              value={advanced.similarity}
              onChange={(v: number) => set({ similarity: v })}
              min={0}
              max={1}
              step={0.01}
              formatValue={(v: number) => String(Math.round(v * 100))}
              disabled={disabled}
            />
          </Field>
        </div>
      </details>
    </>
  );
}
