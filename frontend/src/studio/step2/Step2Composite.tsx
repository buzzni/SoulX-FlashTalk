/**
 * Step2Composite — wizard Step 2 container.
 *
 * Post-Phase-4b: orchestrates 4 sub-components (ProductList,
 * BackgroundPicker, CompositionControls, CompositionVariants) +
 * the existing ServerFilePicker modal. Generation flow uses
 * useCompositeGeneration, which handles the full SSE event set
 * (init / candidate / error / fatal / done) with slot-aware
 * variant state.
 *
 * Uploads now happen eagerly via useUploadReferenceImage when the
 * user picks a product / background file — stale-result rejection
 * means a late upload can't overwrite a newer choice.
 */

import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card } from '../primitives.jsx';
import ServerFilePicker from '../ServerFilePicker.jsx';
import {
  applyPickedFileToBackground,
  applyPickedFileToProducts,
} from '../picker_handler.js';
import { useCompositeGeneration, type CompositionVariant } from '../../hooks/useCompositeGeneration';
import { useUploadReferenceImage } from '../../hooks/useUploadReferenceImage';
import { uploadBackgroundImage, uploadReferenceImage } from '../../api/upload';
import { selectComposite as selectCompositeApi } from '../../api/composite';
import { imageIdFromPath, makeRandomSeeds } from '../../api/mapping';
import { ProductList, type Product } from './ProductList';
import { BackgroundPicker, type Background } from './BackgroundPicker';
import { CompositionControls, type Composition } from './CompositionControls';
import { CompositionVariants } from './CompositionVariants';

const DEFAULT_SEEDS = [10, 42, 77, 128];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UpdateFn = (updater: (state: any) => any) => void;

export interface Step2CompositeProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  update: UpdateFn;
}

export default function Step2Composite({ state, update }: Step2CompositeProps) {
  const products = (state.products ?? []) as Product[];
  const background = (state.background ?? { source: 'preset' }) as Background;
  const composition = (state.composition ?? {}) as Composition & {
    variants?: CompositionVariant[];
    generated?: boolean;
    selectedSeed?: number | null;
    rembg?: boolean;
  };

  const gen = useCompositeGeneration();
  const productUpload = useUploadReferenceImage(uploadReferenceImage);
  const backgroundUpload = useUploadReferenceImage(uploadBackgroundImage);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const attemptsRef = useRef<number>((composition.variants ?? []).length > 0 ? 1 : 0);
  const [pickerFor, setPickerFor] = useState<'products' | 'bg' | null>(null);

  const setProducts: ProductListProps['onProductsChange'] = (next) =>
    update((s) => ({
      ...s,
      products: typeof next === 'function' ? next(s.products ?? []) : next,
    }));
  const setBg = (patch: Partial<Background>) =>
    update((s) => ({ ...s, background: { ...(s.background ?? {}), ...patch } }));
  const setComp = (patch: Partial<Composition>) =>
    update((s) => ({ ...s, composition: { ...(s.composition ?? {}), ...patch } }));

  // Auto-scroll to results on stream start or when variants land.
  useEffect(() => {
    if (!(gen.isLoading || gen.variants.length > 0) || !resultsRef.current) return;
    const scroller =
      resultsRef.current.closest('.left-col') ||
      document.scrollingElement ||
      document.documentElement;
    if (scroller && 'scrollTo' in scroller) {
      const top = resultsRef.current.offsetTop - 80;
      scroller.scrollTo({ top, behavior: 'smooth' });
    }
  }, [gen.isLoading, gen.variants.length]);

  const bgReady = !!(
    background.preset ||
    background.imageUrl ||
    background.url ||
    background._gradient ||
    background._file ||
    background.uploadPath
  );
  const productsReady =
    products.length > 0 &&
    products.some((p) => p.url || p.urlInput || p._file || p.path);
  const canGenerate = bgReady && productsReady;
  const missingReason = !canGenerate
    ? `${!productsReady ? '제품 사진을 먼저 올려주세요. ' : ''}${!bgReady ? '배경을 선택해주세요.' : ''}`
    : null;

  // Kicks product uploads for any row that has `_file` but no `path`,
  // same for the background. We do this inside the generate click
  // so uploads stale-reject correctly — a user hammering "합성" then
  // swapping files shouldn't see A's upload override B's state.
  const generate = async () => {
    const attempt = attemptsRef.current;
    const seeds = attempt === 0 ? undefined : makeRandomSeeds(4);
    attemptsRef.current = attempt + 1;

    // Upload missing product paths.
    const uploaded = await Promise.all(
      products.map(async (p) => {
        if (p.path || !p._file) return p;
        const r = await productUpload.upload(p._file);
        return r ? { ...p, path: r.path ?? undefined } : p;
      }),
    );
    update((s) => ({ ...s, products: uploaded }));

    // Upload missing background path.
    let bg = background;
    if (background.source === 'upload' && background._file && !background.uploadPath) {
      const rawFile =
        // Unwrap the UploadTile wrapper { _file: File } or accept a raw File.
        (background._file as { _file?: File })._file ??
        (background._file as unknown as File | Blob);
      if (rawFile instanceof Blob) {
        const r = await backgroundUpload.upload(rawFile);
        if (r) {
          bg = { ...background, uploadPath: r.path };
          setBg({ uploadPath: r.path ?? null });
        }
      }
    }

    await gen.regenerate(
      {
        host: { selectedPath: state.host?.selectedPath ?? null },
        products: uploaded.filter((p) => p.path) as CompositeInputProducts,
        background: bg as unknown as CompositeInputBg,
        composition: composition as unknown as CompositeInputComp,
        imageSize: (state.imageQuality as '1K' | '2K' | '4K') ?? '1K',
      },
      seeds,
      { rembg: composition.rembg !== false },
    );
  };

  const selectComposite = (v: CompositionVariant) => {
    update((s) => ({
      ...s,
      composition: {
        ...(s.composition ?? {}),
        generated: true,
        selectedSeed: v.seed,
        selectedPath: v.path ?? null,
        selectedUrl: v.url ?? null,
        selectedImageId: v.imageId ?? null,
      },
    }));
    if (v.imageId) {
      selectCompositeApi(v.imageId).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('composite select sync failed (non-fatal):', e);
      });
    }
  };

  const handlePickedServerFile = (f: unknown) => {
    if (pickerFor === 'bg') {
      setBg(applyPickedFileToBackground(background, f));
    } else if (pickerFor === 'products') {
      setProducts((ps) => applyPickedFileToProducts(ps, f));
    }
    setPickerFor(null);
  };

  return (
    <div className="step-page">
      <div className="step-heading">
        <h1>2단계 · 제품과 배경 합성하기</h1>
        <p>
          쇼호스트·제품·배경을 한 장의 사진으로 합쳐요. 이 스틸 이미지가 다음 단계(음성·영상)의
          바탕이 돼요.
        </p>
      </div>

      <Card
        title="소개할 상품"
        subtitle="여러 개 추가할 수 있어요. 구도 지시에서 ①②③ 번호로 지칭해요"
        action={
          <div style={{ display: 'flex', gap: 6 }}>
            <Button icon="file" size="sm" onClick={() => setPickerFor('products')}>
              서버 파일 선택
            </Button>
            <Button
              icon="plus"
              size="sm"
              onClick={() =>
                setProducts((ps) => [
                  ...ps,
                  { id: Date.now().toString(36), url: null, source: 'upload' },
                ])
              }
            >
              제품 추가
            </Button>
          </div>
        }
      >
        <ProductList
          products={products}
          rembgKeep={composition.rembg === false}
          onProductsChange={setProducts}
          onRembgChange={(remove) => setComp({ rembg: remove } as Composition)}
          onPickServerFile={() => setPickerFor('products')}
        />
      </Card>

      <Card title="배경" subtitle="어디서 촬영한 느낌으로 보이게 할지 골라주세요">
        <BackgroundPicker
          background={background}
          onBackgroundChange={setBg}
          onPickServerFile={() => setPickerFor('bg')}
        />
      </Card>

      <Card
        title="구도 — 어떻게 놓여있게 할까요?"
        subtitle="쇼호스트 자세·제품 위치를 자유롭게 적어주세요. 배경에 있는 가구·공간에 맞춰 합성돼요."
      >
        <CompositionControls
          composition={composition}
          products={products}
          generating={gen.isLoading}
          errorMsg={gen.error}
          canGenerate={canGenerate}
          missingReason={missingReason}
          onCompositionChange={setComp}
          onGenerate={generate}
        />
      </Card>

      {(gen.isLoading || gen.variants.length > 0 || composition.generated) && (
        <div ref={resultsRef}>
          <Card
            title="↓ 합성 결과 · 이 중에서 골라주세요"
            subtitle={
              gen.isLoading
                ? '배경·제품·쇼호스트를 합성하는 중이에요. 잠시만 기다려주세요.'
                : '마음에 드는 후보를 클릭하면 선택돼요.'
            }
          >
            <CompositionVariants
              variants={gen.variants}
              prevSelected={gen.prevSelected}
              selectedImageId={
                (composition as { selectedImageId?: string | null }).selectedImageId ??
                imageIdFromPath((composition as { selectedPath?: string | null }).selectedPath)
              }
              onSelect={selectComposite}
            />
            {composition.generated && (
              <div className="mt-3 flex justify-between items-center">
                <Badge variant="success" icon="check_circle">
                  합성 완료 · 다음 단계로 진행하세요
                </Badge>
                <Button size="sm" icon="refresh" onClick={generate}>
                  다시 만들기
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}

      <ServerFilePicker
        open={pickerFor !== null}
        kind="image"
        onClose={() => setPickerFor(null)}
        onSelect={handlePickedServerFile}
      />
    </div>
  );
}

// Local-only type aliases used by the regenerate() call above —
// avoids yet more indirection through imported types.
type CompositeInputProducts = React.ComponentProps<
  typeof ProductList
>['products'];
type CompositeInputBg = React.ComponentProps<typeof BackgroundPicker>['background'];
type CompositeInputComp = React.ComponentProps<
  typeof CompositionControls
>['composition'];

type ProductListProps = React.ComponentProps<typeof ProductList>;
