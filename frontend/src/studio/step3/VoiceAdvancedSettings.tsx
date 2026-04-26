/**
 * VoiceAdvancedSettings — TTS tuning sliders.
 *
 * Speed lives outside the collapsible (users tweak it often);
 * stability / style / similarity live inside a <details> because
 * most people never touch them. `voice.pitch` was cut pre-
 * refactor — not an ElevenLabs v3 param and the ffmpeg post-
 * processing pipeline to do it ourselves isn't built.
 */

import Icon from '../Icon.jsx';
import { Field } from '@/components/field';
import { WizardSlider as Slider } from '@/components/wizard-slider';
import type { VoiceAdvanced } from '@/wizard/schema';

export interface VoiceAdvancedSettingsProps {
  advanced: VoiceAdvanced;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdvancedChange: (next: VoiceAdvanced) => void;
}

export function VoiceAdvancedSettings({
  advanced,
  open,
  onOpenChange,
  onAdvancedChange,
}: VoiceAdvancedSettingsProps) {
  const set = (patch: Partial<VoiceAdvanced>) =>
    onAdvancedChange({ ...advanced, ...patch });
  return (
    <>
      <div className="field-row" style={{ marginTop: 12 }}>
        <Field label={`읽는 속도 · ${advanced.speed.toFixed(2)}배`} hint="0.5배 ~ 1.8배">
          <Slider
            value={advanced.speed}
            onChange={(v: number) => set({ speed: v })}
            min={0.5}
            max={1.8}
            step={0.05}
            formatValue={(v: number) => `${v.toFixed(2)}x`}
          />
        </Field>
      </div>

      <details
        style={{ marginTop: 12 }}
        open={open}
        onToggle={(e) => onOpenChange((e.target as HTMLDetailsElement).open)}
      >
        <summary
          style={{
            cursor: 'pointer',
            userSelect: 'none',
            fontSize: 12,
            color: 'var(--text-tertiary)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Icon name={open ? 'chevron_up' : 'chevron_down'} size={11} />
          목소리 세밀 조정 (고급, 대부분 그대로 두셔도 괜찮아요)
        </summary>
        <div className="field-row-3" style={{ marginTop: 10 }}>
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
            />
          </Field>
        </div>
      </details>
    </>
  );
}
