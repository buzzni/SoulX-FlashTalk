/**
 * ProductList — draggable product-card list for Step 2.
 *
 * First product → single UploadTile (simpler first-run UX). After
 * that, a row per product with drag-to-reorder, upload / url
 * source switch, and remove button. The numbering (1번, 2번 …)
 * matches the chip labels the direction-textarea highlight expects.
 *
 * Reads/writes through `useFormContext` + `useFieldArray` — the
 * parent Step2Composite owns the form via `<FormProvider>`. Drag
 * reorder uses `move(from, to)`; per-row source-kind swaps replace
 * the whole product object via `update(i, next)` because the source
 * union changes shape.
 *
 * Phase 2c: schema-typed. Each row carries a `source: ProductSource`
 * tagged union (empty / localFile / uploaded / url).
 */

import { useState } from 'react';
import { useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import Icon from '../Icon.jsx';
import { cn } from '@/lib/utils';
import { Field } from '@/components/field';
import { UploadTile } from '@/components/upload-tile';
import {
  localAssetFromUploadFile,
  revokeLocalAssetIfBlob,
} from '@/components/upload-tile-bridge';
import { OptionCard } from '@/components/option-card';
import { isProductReady, type Product } from '@/wizard/schema';
import type { Step2FormValues } from '@/wizard/form-mappers';

export type { Product } from '@/wizard/schema';

/** Displayable preview URL for a Product, derived from its source
 * discriminator. Exported so CompositionControls's product-ref chip
 * thumbnails can share the projection. */
export function productPreviewUrl(p: Product): string | null {
  switch (p.source.kind) {
    case 'empty':
      return null;
    case 'localFile':
      return p.source.asset.previewUrl;
    case 'uploaded':
      return p.source.asset.url ?? null;
    case 'url':
      // URL source kind retired from the UI in Step 2 — preserved in
      // the schema so legacy persisted state still parses.
      return p.source.url || null;
  }
}

export function ProductList() {
  const { control, setValue } = useFormContext<Step2FormValues>();
  const { fields, update, remove, move } = useFieldArray<Step2FormValues, 'products', 'id'>({
    control,
    name: 'products',
    keyName: 'id',
  });
  const watched = useWatch({ control, name: 'products' });
  const products = (watched ?? []) as Product[];
  const rembgKeep = !useWatch({ control, name: 'settings.rembg' });

  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const onDragStart = (idx: number) => setDragIdx(idx);
  const onDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === idx) return;
    move(dragIdx, idx);
    setDragIdx(idx);
  };
  const onDragEnd = () => setDragIdx(null);

  const allEmpty = products.length === 0 || products.every((p) => !isProductReady(p));

  return (
    <>
      {allEmpty ? (
        <UploadTile
          onFile={(f) => {
            const asset = localAssetFromUploadFile(f);
            if (!asset) return;
            setValue(
              'products',
              [{ id: Date.now().toString(36), name: asset.name, source: { kind: 'localFile', asset } }],
              { shouldDirty: true, shouldValidate: true },
            );
          }}
          label="제품 사진 올리기"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {fields.map((field, idx) => {
            const p = products[idx];
            if (!p) return null;
            const url = productPreviewUrl(p);
            return (
              <div
                key={field.id}
                draggable
                onDragStart={() => onDragStart(idx)}
                onDragOver={(e) => onDragOver(e, idx)}
                onDragEnd={onDragEnd}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-md border border-border bg-card shadow-xs transition-[border-color,box-shadow,opacity] duration-150',
                  'hover:border-rule-strong hover:shadow-sm',
                  dragIdx === idx && 'opacity-40 shadow-md',
                )}
              >
                <span
                  className="text-muted-foreground cursor-grab p-1"
                  title="끌어서 순서 변경"
                >
                  <Icon name="drag" />
                </span>
                <div className="w-10 h-10 rounded shrink-0 relative overflow-hidden bg-secondary">
                  {url ? (
                    <img src={url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="striped-placeholder text-[9px]">
                      {idx + 1}번
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0 flex-col gap-2">
                  <div className="text-xs font-medium">
                    <strong className="text-primary font-semibold">{idx + 1}번</strong> 상품
                  </div>
                  <label className="self-start inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border border-input bg-card text-foreground hover:bg-secondary cursor-pointer transition-colors">
                    <Icon name={url ? 'swap' : 'upload'} size={12} />
                    {url ? '사진 교체' : '사진 올리기'}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      // Reset value before the click resolves so re-
                      // picking the same file (after a swap intent that
                      // landed on the same path) still fires onChange.
                      // Without this the input keeps its prior value
                      // and the browser suppresses the event.
                      onClick={(e) => {
                        (e.currentTarget as HTMLInputElement).value = '';
                      }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        // Revoke the previous blob: previewUrl when
                        // replacing a localFile so the slot doesn't
                        // accumulate dead object URLs.
                        if (p.source.kind === 'localFile') {
                          revokeLocalAssetIfBlob(p.source.asset);
                        }
                        const reader = new FileReader();
                        reader.onload = (ev) =>
                          update(idx, {
                            ...p,
                            name: file.name,
                            source: {
                              kind: 'localFile',
                              asset: {
                                file,
                                previewUrl: (ev.target?.result as string) || '',
                                name: file.name,
                              },
                            },
                          });
                        reader.readAsDataURL(file);
                      }}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className="inline-flex items-center justify-center size-8 rounded-md text-muted-foreground hover:bg-secondary hover:text-destructive transition-colors"
                  onClick={() => remove(idx)}
                  title="제품 삭제"
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {products.length > 0 && (
        <Field
          label="제품 사진 배경 처리"
          hint="제품 사진의 원래 배경을 어떻게 다룰지"
        >
          <div className="grid grid-cols-2 gap-2">
            <OptionCard
              dense
              active={!rembgKeep}
              title={
                <>
                  자동으로 빼내기{' '}
                  <span className="text-2xs font-medium text-muted-foreground ml-1">
                    (기본)
                  </span>
                </>
              }
              desc="화장품·패션·기기 등 깔끔한 컷에"
              onClick={() => setValue('settings.rembg', true, { shouldDirty: true })}
            />
            <OptionCard
              dense
              active={rembgKeep}
              title="사진 그대로 쓰기"
              desc="음식·인테리어처럼 배경이 분위기에 도움될 때"
              onClick={() => setValue('settings.rembg', false, { shouldDirty: true })}
            />
          </div>
        </Field>
      )}

    </>
  );
}
