/**
 * AudioUploader — user uploads a raw audio file that we splice
 * directly into the generated video (no TTS).
 *
 * Also accepts an optional subtitle script (schema `Script`) so the
 * video can render on-screen text matching what the user said.
 *
 * Phase 2c.4: schema-typed. Emits `voice.audio` (ServerAsset |
 * LocalAsset | null) — Step3Audio orchestrates the local→server
 * upload transition; this component only stages the file.
 */

import Icon from '../Icon.jsx';
import { Field } from '@/components/field';
import { UploadTile } from '@/components/upload-tile';
import { isLocalAsset } from '@/wizard/normalizers';
import type { LocalAsset, Script, ServerAsset } from '@/wizard/schema';

export interface AudioUploaderProps {
  audio: ServerAsset | LocalAsset | null;
  script: Script;
  /** True while the staged LocalAsset is being uploaded to the
   * server. Step3Audio drives this from `useUploadReferenceImage`. */
  isUploading?: boolean;
  onAudioChange: (audio: ServerAsset | LocalAsset | null) => void;
  onScriptChange: (script: Script) => void;
}

interface UploadTileFile {
  name?: string;
  size?: number;
  type?: string;
  url?: string | null;
  _file?: File;
}

export function AudioUploader({
  audio,
  script,
  isUploading = false,
  onAudioChange,
  onScriptChange,
}: AudioUploaderProps) {
  // UploadTile speaks the legacy `{name, _file, url}` shape; we lift
  // to/from schema here so the rest of the component reads cleanly.
  const tileFile: UploadTileFile | null = (() => {
    if (!audio) return null;
    if (isLocalAsset(audio)) {
      return {
        name: audio.name,
        size: audio.file.size,
        type: audio.file.type,
        url: audio.previewUrl,
        _file: audio.file,
      };
    }
    return { name: audio.name, url: audio.url };
  })();

  const handlePick = (next: UploadTileFile | null) => {
    if (!next || !next._file) {
      onAudioChange(null);
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
    onAudioChange(asset);
  };

  const subtitleText = script.paragraphs.join('\n\n');

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
      <Field
        label="녹음 파일"
        hint={isUploading ? '업로드 중…' : 'MP3, WAV, M4A · 최대 50MB'}
      >
        <UploadTile
          file={tileFile}
          onFile={handlePick}
          onRemove={() => onAudioChange(null)}
          accept="audio/*"
          label="녹음 파일 올리기"
          sub="MP3, WAV, M4A"
        />
      </Field>
      <Field label="자막으로 표시할 대본 (선택)" hint="영상에 자막을 보여주고 싶을 때만">
        <textarea
          className="textarea"
          placeholder="녹음 내용을 그대로 적어주시면 영상에 자막으로 나와요."
          value={subtitleText}
          onChange={(e) => {
            // Subtitle script is single-textarea; split paragraph
            // boundaries on blank-line separators so the schema
            // multi-paragraph shape stays consistent with TTS mode.
            const paragraphs = e.target.value.split(/\n\s*\n/);
            onScriptChange({ paragraphs: paragraphs.length > 0 ? paragraphs : [''] });
          }}
        />
      </Field>
    </div>
  );
}
