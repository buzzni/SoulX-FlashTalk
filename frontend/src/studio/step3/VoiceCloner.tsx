/**
 * VoiceCloner — user uploads a recording sample; backend clones it
 * into an ElevenLabs voice_id we can then use for TTS generation.
 *
 * Phase 2c.4: schema-typed. Drives the `voice.sample` state machine
 * (empty → pending → cloned). The actual clone-on-generate happens
 * in Step3Audio via useVoiceClone — this component only stages the
 * file (pending) or surfaces the cloned identity (cloned).
 */

import Icon from '../Icon.jsx';
import { Field } from '@/components/field';
import { UploadTile } from '@/components/upload-tile';
import type { LocalAsset, VoiceCloneSample } from '@/wizard/schema';

export interface VoiceClonerProps {
  sample: VoiceCloneSample;
  onSampleChange: (sample: VoiceCloneSample) => void;
}

interface UploadTileFile {
  name?: string;
  size?: number;
  type?: string;
  url?: string | null;
  _file?: File;
}

export function VoiceCloner({ sample, onSampleChange }: VoiceClonerProps) {
  // UploadTile speaks the legacy `{name, size, _file, url}` shape;
  // we lift to/from schema here so the component is the only place
  // touching that shape.
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
    if (sample.state === 'cloned') {
      return { name: sample.name };
    }
    return null;
  })();

  const handlePick = (next: UploadTileFile | null) => {
    if (!next || !next._file) {
      onSampleChange({ state: 'empty' });
      return;
    }
    const asset: LocalAsset = {
      file: next._file,
      previewUrl:
        typeof next.url === 'string' && next.url
          ? next.url
          : URL.createObjectURL(next._file),
      name: next.name ?? next._file.name,
    };
    onSampleChange({ state: 'pending', asset });
  };

  return (
    <div className="flex-col gap-3">
      <div
        style={{
          padding: 12,
          background: 'var(--accent-soft)',
          borderRadius: 'var(--r-sm)',
          border: '1px solid var(--accent-soft-border)',
          fontSize: 12,
          color: 'var(--accent-text)',
          display: 'flex',
          gap: 8,
          alignItems: 'flex-start',
        }}
      >
        <Icon name="info" size={14} />
        <div>
          본인 또는 성우의 녹음 파일을 올리면, 그 목소리 그대로 대본을 읽어드려요.
          조용한 곳에서 녹음한 10초 이상의 깨끗한 파일을 추천해요.
        </div>
      </div>
      <Field label="참고할 녹음 파일" hint="MP3 또는 WAV">
        <UploadTile
          file={tileFile}
          onFile={handlePick}
          onRemove={() => onSampleChange({ state: 'empty' })}
          accept="audio/*"
          label="녹음 파일 올리기"
          sub="10초 이상, 주변 소음 없는 파일"
        />
      </Field>
      {sample.state === 'cloned' && (
        <div
          className="flex items-center gap-3"
          style={{ padding: 12, background: 'var(--success-soft)', borderRadius: 'var(--r-sm)' }}
        >
          <Icon name="check_circle" size={16} style={{ color: 'var(--success)' }} />
          <div className="text-sm" style={{ color: 'var(--success)' }}>
            목소리 준비 완료! 이제 이 목소리로 대본을 읽어드려요.
          </div>
        </div>
      )}
    </div>
  );
}
