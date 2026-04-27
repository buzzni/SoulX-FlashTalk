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
import { Segmented } from '@/components/segmented';
import { UploadTile } from '@/components/upload-tile';
import { localAssetFromUploadFile } from '@/components/upload-tile-bridge';
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
      return p.source.url || null;
  }
}

export function ProductList() {
  const { control, setValue } = useFormContext<Step2FormValues>();
  // `append` lives in the parent (Card header has its own "제품 추가"
  // button that calls form.setValue directly) — we only need fields,
  // update, remove, move here.
  const { fields, update, remove, move } = useFieldArray<Step2FormValues, 'products', 'id'>({
    control,
    name: 'products',
    keyName: 'id',
  });
  // useFieldArray's `fields` snapshots row order via the internal `id`
  // key, but each row's `source` discriminator changes don't bubble
  // through `fields` — read live values via `useWatch` so the source
  // toggle re-renders immediately on swap.
  const watched = useWatch({ control, name: 'products' });
  const products = (watched ?? []) as Product[];
  const rembgKeep = !useWatch({ control, name: 'settings.rembg' });

  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const setSource = (idx: number, kind: 'upload' | 'url') => {
    const cur = products[idx];
    if (!cur) return;
    if (kind === 'upload') {
      update(idx, { ...cur, source: { kind: 'empty' } });
    } else {
      update(idx, { ...cur, source: { kind: 'url', url: '', urlInput: '' } });
    }
  };

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
            // Replace the entire products array — this is the empty
            // first-product flow and any leftover empty rows are
            // placeholders the user hasn't engaged with.
            setValue(
              'products',
              [{ id: Date.now().toString(36), name: asset.name, source: { kind: 'localFile', asset } }],
              { shouldDirty: true, shouldValidate: true },
            );
          }}
          label="제품 사진 올리기"
          sub="배경이 없는 PNG가 제일 깔끔해요"
        />
      ) : (
        <div className="product-list">
          {fields.map((field, idx) => {
            const p = products[idx];
            if (!p) return null;
            const url = productPreviewUrl(p);
            const sourceKind: 'upload' | 'url' = p.source.kind === 'url' ? 'url' : 'upload';
            return (
              <div
                key={field.id}
                className={cn('product-row', dragIdx === idx && 'dragging')}
                draggable
                onDragStart={() => onDragStart(idx)}
                onDragOver={(e) => onDragOver(e, idx)}
                onDragEnd={onDragEnd}
              >
                <span className="product-drag" title="끌어서 순서 변경">
                  <Icon name="drag" />
                </span>
                <div className="product-thumb">
                  {url ? (
                    <img src={url} alt="" />
                  ) : (
                    <div className="striped-placeholder text-[9px]">
                      상품 {idx + 1}
                    </div>
                  )}
                </div>
                <div className="product-info flex-col gap-2">
                  <div className="product-label text-xs">
                    상품 {idx + 1}
                    <span className="text-tertiary ml-1.5 font-normal">
                      · 구도 지시에서{' '}
                      <strong className="text-accent font-semibold">{idx + 1}번</strong>
                    </span>
                  </div>
                  <Segmented
                    value={sourceKind}
                    onChange={(v: 'upload' | 'url') => setSource(idx, v)}
                    options={[
                      { value: 'upload', label: '사진 올리기', icon: 'upload' },
                      { value: 'url', label: '쇼핑몰 주소', icon: 'link' },
                    ]}
                  />
                  {p.source.kind === 'url' && (
                    <div className="input-group">
                      <span className="prefix">
                        <Icon name="link" size={12} />
                      </span>
                      <input
                        className="input has-prefix"
                        placeholder="예) https://smartstore.naver.com/..."
                        value={p.source.urlInput}
                        onChange={(e) => {
                          const next = e.target.value;
                          update(idx, {
                            ...p,
                            source: { kind: 'url', url: next, urlInput: next },
                          });
                        }}
                      />
                    </div>
                  )}
                  {(p.source.kind === 'empty' ||
                    p.source.kind === 'localFile' ||
                    p.source.kind === 'uploaded') && (
                    <label className="self-start inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium border border-input bg-card text-foreground hover:bg-secondary cursor-pointer transition-colors">
                      <Icon name={url ? 'swap' : 'upload'} size={12} />
                      {url ? '사진 교체' : '사진 올리기'}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
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
                  )}
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
          hint="합성할 때 제품 사진의 원래 배경을 어떻게 다룰지 정해요"
        >
          <div className="grid grid-cols-2 gap-2">
            <OptionCard
              dense
              active={!rembgKeep}
              title={
                <>
                  자동으로 빼내기{' '}
                  <span className="text-[10px] font-medium text-muted-foreground ml-1">
                    (기본)
                  </span>
                </>
              }
              desc="화장품·패션·기기 등 깔끔한 컷에 — 배경 다 지우고 새 배경에 얹음"
              onClick={() => setValue('settings.rembg', true, { shouldDirty: true })}
            />
            <OptionCard
              dense
              active={rembgKeep}
              title="사진 그대로 쓰기"
              desc="음식 플레이팅·가구 인테리어처럼 배경이 분위기에 도움 되는 사진에"
              onClick={() => setValue('settings.rembg', false, { shouldDirty: true })}
            />
          </div>
        </Field>
      )}

    </>
  );
}
