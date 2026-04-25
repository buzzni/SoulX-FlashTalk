/**
 * VoiceCloner — user uploads a recording sample; backend clones it
 * into an ElevenLabs voice_id we can then use for TTS generation.
 *
 * Just the UI — the actual clone-on-generate happens in the
 * container via useVoiceClone. We only need the user to stage a
 * file here.
 */

import Icon from '../Icon.jsx';
import { Field } from '@/components/field';
import { UploadTile } from '@/components/upload-tile';
export interface CloneSample {
  name?: string;
  size?: number;
  type?: string;
  url?: string;
  _file?: File;
  voiceId?: string | null;
}

export interface VoiceClonerProps {
  cloneSample: CloneSample | null;
  onSampleSelected: (f: CloneSample | null) => void;
}

export function VoiceCloner({ cloneSample, onSampleSelected }: VoiceClonerProps) {
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
          file={cloneSample}
          onFile={(f) => onSampleSelected(f)}
          onRemove={() => onSampleSelected(null)}
          accept="audio/*"
          label="녹음 파일 올리기"
          sub="10초 이상, 주변 소음 없는 파일"
        />
      </Field>
      {cloneSample && (
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
