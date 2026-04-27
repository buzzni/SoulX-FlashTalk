/**
 * HostReferenceUploader — image-mode inputs for Step 1.
 *
 * Face / outfit reference uploads with instant preview + server-side
 * upload-on-pick (so the ref survives refresh). Strength sliders +
 * outfit text + extraPrompt round out the image-mode editor.
 *
 * Reads/writes through `useFormContext` — Step1Host owns the form via
 * `<FormProvider>`. Upload side-effects fire `setValue('input.faceRef',
 * ServerAsset)` (not the store) so the form stays the single source of
 * truth; the store→form sync hook in the parent is one-way for store
 * updates that originate elsewhere (mode switches, generation result).
 *
 * Upload choreography uses `useUploadReferenceImage` so stale uploads
 * can't overwrite newer choices (rapid pick-rename pattern used to
 * corrupt state).
 */

import { Controller, useFormContext, type Path } from 'react-hook-form';
import Icon from '../Icon.jsx';
import { Field } from '@/components/field';
import { Segmented } from '@/components/segmented';
import { UploadTile } from '@/components/upload-tile';
import { uploadFileFromAsset, type UploadTileFile } from '@/components/upload-tile-bridge';
import { uploadReferenceImage } from '../../api/upload';
import { useUploadReferenceImage } from '../../hooks/useUploadReferenceImage';
import type { ServerAsset, LocalAsset } from '@/wizard/schema';
import type { HostFormValues } from '@/wizard/form-mappers';

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

type RefFieldName = Path<HostFormValues> & ('input.faceRef' | 'input.outfitRef');

export function HostReferenceUploader() {
  const { control, register, setValue, watch } = useFormContext<HostFormValues>();
  // One uploader per slot — face and outfit have independent in-flight
  // tokens, so a rapid pick-rename on face can't clobber outfit.
  const faceUpload = useUploadReferenceImage(uploadReferenceImage);
  const outfitUpload = useUploadReferenceImage(uploadReferenceImage);

  const faceRef = watch('input.faceRef') as ServerAsset | LocalAsset | null;
  const outfitRef = watch('input.outfitRef') as ServerAsset | LocalAsset | null;

  const makePickHandler =
    (field: RefFieldName, upload: ReturnType<typeof useUploadReferenceImage>) =>
    async (f: UploadTileFile | null) => {
      if (!f) {
        setValue(field, null, { shouldDirty: true });
        return;
      }
      // Pasted/drag without a File object — UploadTile usually attaches one.
      if (!f._file) return;
      const res = await upload.upload(f._file);
      if (res?.path) {
        setValue(
          field,
          { path: res.path, url: res.url, name: f.name },
          { shouldDirty: true, shouldValidate: true },
        );
      }
    };

  const handleFacePick = makePickHandler('input.faceRef', faceUpload);
  const handleOutfitPick = makePickHandler('input.outfitRef', outfitUpload);

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
            file={uploadFileFromAsset(faceRef)}
            onFile={handleFacePick}
            onRemove={() => setValue('input.faceRef', null, { shouldDirty: true })}
            label="얼굴이 나온 사진 올리기"
            sub="정면·밝은 사진 추천"
          />
        </Field>
        <Field label="의상" hint="사진이나 글, 둘 다 가능 · 없어도 돼요">
          <UploadTile
            file={uploadFileFromAsset(outfitRef)}
            onFile={handleOutfitPick}
            onRemove={() => setValue('input.outfitRef', null, { shouldDirty: true })}
            label="입힐 옷 사진 올리기"
            sub="원하는 옷차림이 있을 때"
          />
          <input
            className="input mt-2"
            placeholder="또는 글로 설명: 예) 베이지 니트, 청바지"
            {...register('input.outfitText')}
          />
        </Field>
      </div>

      {faceRef && (
        <Field label="얼굴을 얼마나 비슷하게?" hint="프롬프트 문구에 반영돼요 (연속 수치가 아님)">
          <Controller
            control={control}
            name="input.faceStrength"
            render={({ field }) => (
              <Segmented
                value={strengthValueToStep(field.value as number | null | undefined)}
                onChange={field.onChange}
                options={STRENGTH_STEPS}
              />
            )}
          />
        </Field>
      )}

      {outfitRef && (
        <Field label="옷을 얼마나 비슷하게?" hint="프롬프트 문구에 반영돼요 (연속 수치가 아님)">
          <Controller
            control={control}
            name="input.outfitStrength"
            render={({ field }) => (
              <Segmented
                value={strengthValueToStep(field.value as number | null | undefined)}
                onChange={field.onChange}
                options={STRENGTH_STEPS}
              />
            )}
          />
        </Field>
      )}

      <Field label="추가로 바라는 점 (선택)">
        <input
          className="input"
          placeholder="예) 밝은 표정, 자연스러운 자세"
          {...register('input.extraPrompt')}
        />
      </Field>
    </div>
  );
}
