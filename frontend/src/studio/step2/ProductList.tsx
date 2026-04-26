/**
 * ProductList — draggable product-card list for Step 2.
 *
 * First product → single UploadTile (simpler first-run UX). After
 * that, a row per product with drag-to-reorder, upload / url
 * source switch, and remove button. The numbering (1번, 2번 …)
 * matches the chip labels the direction-textarea highlight
 * expects.
 *
 * Drag-reorder state is local (dragIdx) — parent only sees the
 * final reordered array via `onProductsChange`.
 *
 * Phase 2c: schema-typed. Each row carries a `source: ProductSource`
 * tagged union (empty / localFile / uploaded / url). Helpers below
 * derive what to show (preview URL, server path, etc.) from the
 * discriminator instead of reading flat optional fields.
 */

import { useState } from 'react';
import Icon from '../Icon.jsx';
import { Field } from '@/components/field';
import { Segmented } from '@/components/segmented';
import { UploadTile } from '@/components/upload-tile';
import { OptionCard } from '@/components/option-card';
import type { Product } from '@/wizard/schema';
import { isLocalAsset, isServerAsset } from '@/wizard/normalizers';

export type { Product } from '@/wizard/schema';

/** Derive the displayable preview URL from a ProductSource. */
function previewUrl(p: Product): string | null {
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

function isReadyForGenerate(p: Product): boolean {
  return p.source.kind !== 'empty';
}

export interface ProductListProps {
  products: Product[];
  rembgKeep: boolean;
  onProductsChange: (next: Product[] | ((prev: Product[]) => Product[])) => void;
  onRembgChange: (remove: boolean) => void;
  onPickServerFile: () => void;
}

export function ProductList({
  products,
  rembgKeep,
  onProductsChange,
  onRembgChange,
  onPickServerFile,
}: ProductListProps) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const updateProduct = (id: string, patch: Partial<Product>) => {
    onProductsChange((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };
  const setSource = (id: string, kind: 'upload' | 'url') => {
    onProductsChange((ps) =>
      ps.map((p) => {
        if (p.id !== id) return p;
        if (kind === 'upload') {
          return { ...p, source: { kind: 'empty' } };
        }
        return { ...p, source: { kind: 'url', url: '', urlInput: '' } };
      }),
    );
  };
  const removeProduct = (id: string) =>
    onProductsChange((ps) => ps.filter((p) => p.id !== id));

  const onDragStart = (idx: number) => setDragIdx(idx);
  const onDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === idx) return;
    onProductsChange((ps) => {
      const next = [...ps];
      const [m] = next.splice(dragIdx, 1);
      if (m) next.splice(idx, 0, m);
      setDragIdx(idx);
      return next;
    });
  };
  const onDragEnd = () => setDragIdx(null);

  const allEmpty = products.length === 0 || products.every((p) => !isReadyForGenerate(p));

  return (
    <>
      {allEmpty ? (
        <UploadTile
          onFile={(f) => {
            if (!f) return;
            const file = f._file;
            if (!(file instanceof File)) return;
            onProductsChange([
              {
                id: Date.now().toString(36),
                name: f.name,
                source: {
                  kind: 'localFile',
                  asset: {
                    file,
                    previewUrl: f.url ?? '',
                    name: f.name ?? file.name,
                  },
                },
              },
            ]);
          }}
          label="제품 사진 올리기"
          sub="배경이 없는 PNG가 제일 깔끔해요"
        />
      ) : (
        <div className="product-list">
          {products.map((p, idx) => {
            const url = previewUrl(p);
            const sourceKind: 'upload' | 'url' = p.source.kind === 'url' ? 'url' : 'upload';
            return (
              <div
                key={p.id}
                className={`product-row ${dragIdx === idx ? 'dragging' : ''}`}
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
                    <div className="striped-placeholder" style={{ fontSize: 9 }}>
                      상품 {idx + 1}
                    </div>
                  )}
                </div>
                <div className="product-info flex-col gap-2">
                  <div className="product-label text-xs">
                    상품 {idx + 1}
                    <span className="text-tertiary" style={{ marginLeft: 6, fontWeight: 400 }}>
                      · 구도 지시에서{' '}
                      <strong style={{ color: 'var(--accent)', fontWeight: 600 }}>
                        {idx + 1}번
                      </strong>
                    </span>
                  </div>
                  <Segmented
                    value={sourceKind}
                    onChange={(v: 'upload' | 'url') => setSource(p.id, v)}
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
                          updateProduct(p.id, {
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
                          // data URL (blob: fails on LAN-IP origins) +
                          // raw File handle for the eager upload call.
                          const reader = new FileReader();
                          reader.onload = (ev) =>
                            updateProduct(p.id, {
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
                  onClick={() => removeProduct(p.id)}
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
              onClick={() => onRembgChange(true)}
            />
            <OptionCard
              dense
              active={rembgKeep}
              title="사진 그대로 쓰기"
              desc="음식 플레이팅·가구 인테리어처럼 배경이 분위기에 도움 되는 사진에"
              onClick={() => onRembgChange(false)}
            />
          </div>
        </Field>
      )}

      {/* "서버 파일 선택" + "제품 추가" buttons live in the parent
       * Card's header `action` slot so they're visible even when
       * the empty-state UploadTile is showing. No duplicate buttons
       * here. */}
    </>
  );
}
