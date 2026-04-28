/**
 * HostReferenceUploader — image-mode inputs for Step 1.
 *
 * Face / outfit reference uploads. The picker stages a `LocalAsset`
 * synchronously so the tile shows preview + filesize immediately, then
 * an effect runs the real upload and swaps the slot to a `ServerAsset`.
 * Mirrors the pattern Step 3's audio uploader uses.
 *
 * Reads/writes through `useFormContext` — Step1Host owns the form via
 * `<FormProvider>`. The `useUploadReferenceImage` hook's epoch contract
 * makes superseded uploads land harmlessly when the user picks rapidly.
 */

import { useEffect } from 'react';
import { Controller, useFormContext, type Path } from 'react-hook-form';
import { Field } from '@/components/field';
import { Segmented } from '@/components/segmented';
import { UploadTile } from '@/components/upload-tile';
import {
  localAssetFromUploadFile,
  revokeLocalAssetIfBlob,
  uploadFileFromAsset,
  type UploadTileFile,
} from '@/components/upload-tile-bridge';
import { isLocalAsset } from '@/wizard/normalizers';
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
  const { control, register, setValue, watch, getValues } = useFormContext<HostFormValues>();
  // One uploader per slot — face and outfit have independent in-flight
  // tokens, so a rapid pick-rename on face can't clobber outfit.
  const faceUpload = useUploadReferenceImage(uploadReferenceImage);
  const outfitUpload = useUploadReferenceImage(uploadReferenceImage);

  const faceRef = watch('input.faceRef') as ServerAsset | LocalAsset | null;
  const outfitRef = watch('input.outfitRef') as ServerAsset | LocalAsset | null;

  const makePickHandler =
    (field: RefFieldName, prev: ServerAsset | LocalAsset | null) =>
    (f: UploadTileFile | null) => {
      if (prev && isLocalAsset(prev)) revokeLocalAssetIfBlob(prev);
      setValue(field, localAssetFromUploadFile(f), {
        shouldDirty: true,
        shouldValidate: true,
      });
    };

  const handleFacePick = makePickHandler('input.faceRef', faceRef);
  const handleOutfitPick = makePickHandler('input.outfitRef', outfitRef);

  // Eager upload — face. When the slot holds a LocalAsset, run the
  // upload and swap to a ServerAsset. The identity check before swap
  // guards against a slower upload landing after the user picked a
  // newer file. Preview URL is preserved across the swap (backend's
  // /api/upload/reference-image returns no `url`, so without this the
  // tile would flicker to an empty src after the swap completes).
  const faceUploadFn = faceUpload.upload;
  useEffect(() => {
    if (!faceRef || !isLocalAsset(faceRef)) return;
    const local = faceRef;
    let alive = true;
    (async () => {
      const res = await faceUploadFn(local.file);
      if (!alive || !res?.path) return;
      const cur = getValues('input');
      if (
        cur.kind !== 'image' ||
        !cur.faceRef ||
        !isLocalAsset(cur.faceRef) ||
        cur.faceRef.file !== local.file
      ) {
        return;
      }
      setValue(
        'input.faceRef',
        {
          path: res.path as string,
          url:
            typeof res.url === 'string'
              ? res.url
              : local.previewUrl?.startsWith('data:')
                ? local.previewUrl
                : undefined,
          name: local.name,
          size: local.file.size,
        },
        { shouldDirty: true },
      );
    })();
    return () => {
      alive = false;
    };
  }, [faceRef, faceUploadFn, getValues, setValue]);

  // Eager upload — outfit (mirror).
  const outfitUploadFn = outfitUpload.upload;
  useEffect(() => {
    if (!outfitRef || !isLocalAsset(outfitRef)) return;
    const local = outfitRef;
    let alive = true;
    (async () => {
      const res = await outfitUploadFn(local.file);
      if (!alive || !res?.path) return;
      const cur = getValues('input');
      if (
        cur.kind !== 'image' ||
        !cur.outfitRef ||
        !isLocalAsset(cur.outfitRef) ||
        cur.outfitRef.file !== local.file
      ) {
        return;
      }
      setValue(
        'input.outfitRef',
        {
          path: res.path as string,
          url:
            typeof res.url === 'string'
              ? res.url
              : local.previewUrl?.startsWith('data:')
                ? local.previewUrl
                : undefined,
          name: local.name,
          size: local.file.size,
        },
        { shouldDirty: true },
      );
    })();
    return () => {
      alive = false;
    };
  }, [outfitRef, outfitUploadFn, getValues, setValue]);

  // Revoke blob: previewUrls when a slot transitions away from its
  // LocalAsset (next pick or unmount). Cleanup runs with the prior
  // closure value, so the LocalAsset that's leaving is what we revoke.
  useEffect(() => {
    return () => {
      if (faceRef && isLocalAsset(faceRef)) revokeLocalAssetIfBlob(faceRef);
    };
  }, [faceRef]);
  useEffect(() => {
    return () => {
      if (outfitRef && isLocalAsset(outfitRef)) revokeLocalAssetIfBlob(outfitRef);
    };
  }, [outfitRef]);

  return (
    <div className="flex-col gap-3">
      <Field label="얼굴" hint="필수">
        <UploadTile
          file={uploadFileFromAsset(faceRef)}
          onFile={handleFacePick}
          onRemove={() => handleFacePick(null)}
          label="얼굴이 나온 사진 올리기"
          sub="JPG, PNG · 최대 20MB"
        />
      </Field>
      <Field label="의상">
        <UploadTile
          file={uploadFileFromAsset(outfitRef)}
          onFile={handleOutfitPick}
          onRemove={() => handleOutfitPick(null)}
          label="입힐 옷 사진 올리기"
          sub="JPG, PNG · 최대 20MB"
        />
      </Field>

      <Field label="의상을 글로 설명">
        <input
          className="input"
          placeholder="예) 베이지 니트, 청바지"
          {...register('input.outfitText')}
        />
      </Field>

      {faceRef && (
        <Field label="얼굴을 얼마나 비슷하게?">
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
        <Field label="옷을 얼마나 비슷하게?">
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

      <Field label="추가로 바라는 점">
        <input
          className="input"
          placeholder="예) 밝은 표정, 자연스러운 자세"
          {...register('input.extraPrompt')}
        />
      </Field>
    </div>
  );
}
