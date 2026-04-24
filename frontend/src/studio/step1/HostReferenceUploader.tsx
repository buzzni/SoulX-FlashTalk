/**
 * HostReferenceUploader — image-mode inputs for Step 1.
 *
 * Face / outfit reference uploads with instant preview + server-side
 * upload-on-pick (so the ref survives refresh). Plus strength
 * sliders (face + outfit) that get collapsed into prompt clauses at
 * api layer, plus optional text outfit description, plus
 * extraPrompt ("추가로 바라는 점").
 *
 * Upload choreography uses `useUploadReferenceImage` so stale
 * uploads can't overwrite newer choices (rapid pick-rename pattern
 * used to corrupt state).
 */

import Icon from '../Icon.jsx';
import { Field, Segmented, UploadTile } from '../primitives.jsx';
import { uploadReferenceImage, type UploadResult } from '../../api/upload';
import { useUploadReferenceImage } from '../../hooks/useUploadReferenceImage';

// Face/outfit strength is not a real Gemini parameter — the mapping
// layer (§5.1.2) collapses 0–1 into one of four English prompt
// clauses. A slider pretends to be continuous; a 4-button Segmented
// matches reality. Each option stores the bucket midpoint so the
// threshold lookup still produces the same clause.
const STRENGTH_STEPS = [
  { value: 0.15, label: '느슨하게' },
  { value: 0.45, label: '참고만' },
  { value: 0.7, label: '가깝게' },
  { value: 0.95, label: '똑같이' },
];

export function strengthValueToStep(v: number | null | undefined): number {
  if (v == null) return 0.7;
  if (v < 0.3) return 0.15;
  if (v < 0.6) return 0.45;
  if (v < 0.85) return 0.7;
  return 0.95;
}

export interface RefFile {
  name?: string;
  size?: number;
  type?: string;
  url?: string;
  _file?: File;
}

export interface HostReferenceUploaderProps {
  faceRef: RefFile | null;
  outfitRef: RefFile | null;
  outfitText: string;
  extraPrompt: string;
  faceStrength: number;
  outfitStrength: number;
  onFaceSelected: (ref: RefFile | null, uploaded?: UploadResult) => void;
  onOutfitSelected: (ref: RefFile | null, uploaded?: UploadResult) => void;
  onOutfitTextChange: (s: string) => void;
  onExtraPromptChange: (s: string) => void;
  onFaceStrengthChange: (v: number) => void;
  onOutfitStrengthChange: (v: number) => void;
}

export function HostReferenceUploader({
  faceRef,
  outfitRef,
  outfitText,
  extraPrompt,
  faceStrength,
  outfitStrength,
  onFaceSelected,
  onOutfitSelected,
  onOutfitTextChange,
  onExtraPromptChange,
  onFaceStrengthChange,
  onOutfitStrengthChange,
}: HostReferenceUploaderProps) {
  const faceUpload = useUploadReferenceImage(uploadReferenceImage);
  const outfitUpload = useUploadReferenceImage(uploadReferenceImage);

  const handleFacePick = async (f: RefFile | null) => {
    onFaceSelected(f);
    if (!f?._file) return;
    const res = await faceUpload.upload(f._file);
    if (res) onFaceSelected(f, res);
  };
  const handleOutfitPick = async (f: RefFile | null) => {
    onOutfitSelected(f);
    if (!f?._file) return;
    const res = await outfitUpload.upload(f._file);
    if (res) onOutfitSelected(f, res);
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
          얼굴 사진이 필요해요. 의상은 비워둬도 됩니다. 원하는 느낌을 더 적으려면 아래
          <b> 추가로 바라는 점</b> 필드를 쓰세요.
        </div>
      </div>

      <div className="field-row">
        <Field label="얼굴" hint="꼭 필요해요">
          <UploadTile
            file={faceRef}
            onFile={handleFacePick}
            onRemove={() => onFaceSelected(null)}
            label="얼굴이 나온 사진 올리기"
            sub="정면·밝은 사진 추천"
          />
        </Field>
        <Field label="의상" hint="사진이나 글, 둘 다 가능 · 없어도 돼요">
          <UploadTile
            file={outfitRef}
            onFile={handleOutfitPick}
            onRemove={() => onOutfitSelected(null)}
            label="입힐 옷 사진 올리기"
            sub="원하는 옷차림이 있을 때"
          />
          <input
            className="input mt-2"
            placeholder="또는 글로 설명: 예) 베이지 니트, 청바지"
            value={outfitText}
            onChange={(e) => onOutfitTextChange(e.target.value)}
          />
        </Field>
      </div>

      {faceRef && (
        <Field label="얼굴을 얼마나 비슷하게?" hint="프롬프트 문구에 반영돼요 (연속 수치가 아님)">
          <Segmented
            value={strengthValueToStep(faceStrength)}
            onChange={onFaceStrengthChange}
            options={STRENGTH_STEPS}
          />
        </Field>
      )}

      {outfitRef && (
        <Field label="옷을 얼마나 비슷하게?" hint="프롬프트 문구에 반영돼요 (연속 수치가 아님)">
          <Segmented
            value={strengthValueToStep(outfitStrength)}
            onChange={onOutfitStrengthChange}
            options={STRENGTH_STEPS}
          />
        </Field>
      )}

      <Field label="추가로 바라는 점 (선택)">
        <input
          className="input"
          placeholder="예) 밝은 표정, 자연스러운 자세"
          value={extraPrompt}
          onChange={(e) => onExtraPromptChange(e.target.value)}
        />
      </Field>
    </div>
  );
}
