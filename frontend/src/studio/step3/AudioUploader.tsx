/**
 * AudioUploader — user uploads a raw audio file that we splice
 * directly into the generated video (no TTS).
 *
 * Also accepts an optional subtitle script so the video can render
 * on-screen text matching what the user said.
 */

import Icon from '../Icon.jsx';
import { Field, UploadTile } from '../primitives.jsx';

export interface UploadedAudio {
  name?: string;
  size?: number;
  type?: string;
  url?: string;
  _file?: File;
  path?: string | null;
}

export interface AudioUploaderProps {
  uploadedAudio: UploadedAudio | null;
  subtitleScript: string;
  onAudioSelected: (f: UploadedAudio | null) => void;
  onSubtitleChange: (s: string) => void;
}

export function AudioUploader({
  uploadedAudio,
  subtitleScript,
  onAudioSelected,
  onSubtitleChange,
}: AudioUploaderProps) {
  return (
    <div className="flex-col gap-3">
      <div
        style={{
          padding: 12,
          background: 'var(--bg-sunken)',
          borderRadius: 'var(--r-sm)',
          fontSize: 12,
          color: 'var(--text-secondary)',
          display: 'flex',
          gap: 8,
          alignItems: 'flex-start',
        }}
      >
        <Icon name="info" size={14} />
        <div>직접 녹음한 MP3·WAV 파일을 그대로 영상에 넣고 싶을 때 사용하세요.</div>
      </div>
      <Field label="녹음 파일" hint="MP3, WAV, M4A · 최대 50MB">
        <UploadTile
          file={uploadedAudio}
          onFile={(f) => onAudioSelected(f)}
          onRemove={() => onAudioSelected(null)}
          accept="audio/*"
          label="녹음 파일 올리기"
          sub="MP3, WAV, M4A"
        />
      </Field>
      <Field label="자막으로 표시할 대본 (선택)" hint="영상에 자막을 보여주고 싶을 때만">
        <textarea
          className="textarea"
          placeholder="녹음 내용을 그대로 적어주시면 영상에 자막으로 나와요."
          value={subtitleScript}
          onChange={(e) => onSubtitleChange(e.target.value)}
        />
      </Field>
    </div>
  );
}
