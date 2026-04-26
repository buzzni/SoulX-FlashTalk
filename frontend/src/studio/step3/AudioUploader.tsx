/**
 * AudioUploader — user uploads a raw audio file that we splice
 * directly into the generated video (no TTS).
 *
 * Also accepts an optional subtitle script (schema `Script`) so the
 * video can render on-screen text matching what the user said.
 *
 * Emits `voice.audio` (ServerAsset | LocalAsset | null) — Step3Audio
 * orchestrates the local→server upload transition; this component
 * only stages the file.
 */

import { useEffect } from 'react';
import Icon from '../Icon.jsx';
import { Field } from '@/components/field';
import { UploadTile } from '@/components/upload-tile';
import {
  localAssetFromUploadFile,
  revokeLocalAssetIfBlob,
  uploadFileFromAsset,
  type UploadTileFile,
} from '@/components/upload-tile-bridge';
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

export function AudioUploader({
  audio,
  script,
  isUploading = false,
  onAudioChange,
  onScriptChange,
}: AudioUploaderProps) {
  // Revoke our blob: previewUrl when the LocalAsset is replaced or
  // unmounted. data: URLs (the FileReader path) are no-ops.
  useEffect(() => {
    return () => {
      if (audio && isLocalAsset(audio)) revokeLocalAssetIfBlob(audio);
    };
  }, [audio]);

  const tileFile = uploadFileFromAsset(audio);

  const handlePick = (next: UploadTileFile | null) => {
    if (audio && isLocalAsset(audio)) revokeLocalAssetIfBlob(audio);
    onAudioChange(localAssetFromUploadFile(next));
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
          onRemove={() => handlePick(null)}
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
            // Subtitle is a single textarea; split on blank-line
            // separators so the schema multi-paragraph shape stays
            // consistent with TTS mode.
            const paragraphs = e.target.value.split(/\n\s*\n/);
            onScriptChange({ paragraphs: paragraphs.length > 0 ? paragraphs : [''] });
          }}
        />
      </Field>
    </div>
  );
}
