/**
 * VoiceCloner — user uploads a recording sample; backend clones it
 * into an ElevenLabs voice_id we can then use for TTS generation.
 *
 * Drives the `voice.sample` state machine (empty → pending → cloned).
 * The actual clone-on-generate happens in Step3Audio's submit via
 * useVoiceClone — this component only stages the file (pending) or
 * surfaces the cloned identity (cloned).
 *
 * Reads/writes through `useFormContext` — only renders when the
 * parent narrows on `voice.source === 'clone'`, so 'voice.sample' is
 * a valid path here.
 */

import { useEffect } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import Icon from '../Icon.jsx';
import { Field } from '@/components/field';
import { UploadTile } from '@/components/upload-tile';
import { WizardInfoBanner } from '@/components/wizard-info-banner';
import {
  localAssetFromUploadFile,
  revokeLocalAssetIfBlob,
  type UploadTileFile,
} from '@/components/upload-tile-bridge';
import type { VoiceCloneSample } from '@/wizard/schema';
import type { Step3FormValues } from '@/wizard/form-mappers';

/** Strip the file extension off a filename and clip to ~30 chars so it
 * fits ElevenLabs' voice-name display. Used as the submit-time fallback
 * when the user didn't type a name. Exported so Step3Audio's submit can
 * fall back to the same value. */
export function defaultClonedName(filename: string | undefined | null): string {
  if (!filename) return '';
  const base = filename.replace(/\.[^.]+$/, '').trim();
  return base.slice(0, 30);
}

export function VoiceCloner() {
  const { control, setValue } = useFormContext<Step3FormValues>();
  const sample = useWatch({
    control,
    name: 'voice.sample' as const,
  }) as VoiceCloneSample | undefined;
  // `pendingName` lives on the clone-source itself (not on
  // `sample.pending`) so the input stays mounted across empty/pending
  // transitions and never loses what the user typed.
  const pendingName = useWatch({
    control,
    name: 'voice.pendingName' as const,
  }) as string | undefined;

  // Revoke our blob: previewUrl on replace or unmount.
  useEffect(() => {
    return () => {
      if (sample && sample.state === 'pending')
        revokeLocalAssetIfBlob(sample.asset);
    };
  }, [sample]);

  if (!sample) return null;

  const tileFile: UploadTileFile | null = (() => {
    if (sample.state === 'pending') {
      return {
        name: sample.asset.name,
        size: sample.asset.file.size,
        type: sample.asset.file.type,
        url: sample.asset.previewUrl,
        _file: sample.asset.file,
      };
    }
    if (sample.state === 'cloned') return { name: sample.name };
    return null;
  })();

  const writeSample = (next: VoiceCloneSample) =>
    setValue('voice.sample' as const, next, {
      shouldDirty: true,
      shouldValidate: true,
    });

  const handlePick = (next: UploadTileFile | null) => {
    if (sample.state === 'pending') revokeLocalAssetIfBlob(sample.asset);
    const asset = localAssetFromUploadFile(next);
    if (!asset) {
      writeSample({ state: 'empty' });
      return;
    }
    writeSample({ state: 'pending', asset });
  };

  const writeName = (name: string) => {
    setValue('voice.pendingName' as const, name, {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  // Placeholder draws from the staged file when present, otherwise
  // shows a neutral example. Stays consistent across empty/pending so
  // the field doesn't visually flicker on file pick.
  const namePlaceholder = (() => {
    if (sample.state === 'pending') {
      return defaultClonedName(sample.asset.name) || '내 목소리';
    }
    return '내 목소리';
  })();
  const isNameDisabled = sample.state === 'cloned';

  return (
    <div className="flex-col gap-3">
      <WizardInfoBanner>
        본인 또는 성우의 녹음 파일을 올리면, 그 목소리 그대로 대본을 읽어드려요.
        조용한 곳에서 녹음한 10초 이상의 깨끗한 파일을 추천해요.
        <br />
        <span className="opacity-80">
          한 번 만든 클론은 계속 보관돼요 — 다음 영상에서는 ‘목소리 고르기 → 내 클론
          목소리’에서 다시 골라 쓸 수 있어요.
        </span>
      </WizardInfoBanner>
      <Field label="참고할 녹음 파일" hint="MP3 또는 WAV">
        <UploadTile
          file={tileFile}
          onFile={handlePick}
          onRemove={() => handlePick(null)}
          accept="audio/*"
          label="녹음 파일 올리기"
          sub="10초 이상, 주변 소음 없는 파일"
        />
      </Field>
      <Field
        label="클론 이름"
        hint={
          isNameDisabled
            ? '이미 등록된 이름이에요'
            : "'목소리 고르기 → 내 클론 목소리'에서 이 이름으로 보여요"
        }
      >
        <input
          className="input"
          placeholder={`예) ${namePlaceholder}`}
          value={isNameDisabled ? sample.name : (pendingName ?? '')}
          onChange={(e) => writeName(e.target.value)}
          maxLength={40}
          disabled={isNameDisabled}
        />
      </Field>
      {sample.state === 'cloned' && (
        <div className="flex items-start gap-3 p-3 bg-success-soft rounded-sm">
          <Icon name="check_circle" size={16} className="text-success mt-0.5 shrink-0" />
          <div className="text-sm text-success leading-snug">
            목소리 준비 완료! 이제 이 목소리로 대본을 읽어드려요.
            <div className="text-xs opacity-80 mt-0.5">
              다음 영상에서는 ‘목소리 고르기 → 내 클론 목소리’에서 바로 골라 쓸 수 있어요.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
