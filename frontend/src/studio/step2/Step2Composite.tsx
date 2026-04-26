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

import { useRef, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { WizardBadge as Badge } from '@/components/wizard-badge';
import { WizardButton as Button } from '@/components/wizard-button';
import { WizardCard as Card } from '@/components/wizard-card';
import ServerFilePicker from '../ServerFilePicker.jsx';
import { applyPickedFileToProducts } from '../picker_handler.js';
import { useCompositeGeneration, type CompositionVariant } from '../../hooks/useCompositeGeneration';
import { useUploadReferenceImage } from '../../hooks/useUploadReferenceImage';
import { uploadBackgroundImage, uploadReferenceImage } from '../../api/upload';
import { selectComposite as selectCompositeApi, type CompositeInput } from '../../api/composite';
import { imageIdFromPath, makeRandomSeeds } from '../../api/mapping';
import { ProductList, type Product } from './ProductList';
import { BackgroundPicker } from './BackgroundPicker';
import { CompositionControls, type Composition } from './CompositionControls';
import { CompositionVariants } from './CompositionVariants';
import { StepHeading } from '@/routes/StepHeading';
import type { Background } from '@/wizard/schema';
import { isBackgroundReady } from '@/wizard/schema';
import { isLocalAsset, isServerAsset } from '@/wizard/normalizers';

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
  const background = (state.background ?? { kind: 'preset', presetId: null }) as Background;
  const composition = (state.composition ?? {}) as Composition & {
    variants?: CompositionVariant[];
    generated?: boolean;
    selectedSeed?: number | null;
    rembg?: boolean;
  };

  const gen = useCompositeGeneration();
  const productUpload = useUploadReferenceImage(uploadReferenceImage);
  const backgroundUpload = useUploadReferenceImage(uploadBackgroundImage);
  const attemptsRef = useRef<number>((composition.variants ?? []).length > 0 ? 1 : 0);
  const [pickerFor, setPickerFor] = useState<'products' | 'bg' | null>(null);

  const setProducts: ProductListProps['onProductsChange'] = (next) =>
    update((s) => ({
      ...s,
      products: typeof next === 'function' ? next(s.products ?? []) : next,
    }));
  /** Schema-typed replace-style. Tagged unions don't compose with
   * Partial — callers either hand the next full Background or a
   * function deriving it from the previous slice. */
  const setBg = (next: Background | ((prev: Background) => Background)) =>
    update((s) => ({
      ...s,
      background: typeof next === 'function' ? next(s.background) : next,
    }));
  const setComp = (patch: Partial<Composition>) =>
    update((s) => ({ ...s, composition: { ...(s.composition ?? {}), ...patch } }));

  const bgReady = isBackgroundReady(background);
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

    // Upload pending background file (if upload mode + LocalAsset).
    let bg = background;
    if (bg.kind === 'upload' && isLocalAsset(bg.asset)) {
      const r = await backgroundUpload.upload(bg.asset.file);
      if (r?.path) {
        bg = {
          kind: 'upload',
          asset: { path: r.path, url: r.url, name: bg.asset.name },
        };
        setBg(bg);
      }
    }

    // Phase 2b: host is schema-typed. selectedPath comes from
    // generation.selected when state === 'ready'.
    const hostSelectedPath =
      state.host?.generation?.state === 'ready'
        ? state.host.generation.selected?.path ?? null
        : null;

    await gen.regenerate(
      {
        host: { selectedPath: hostSelectedPath },
        products: uploaded.filter((p) => p.path) as CompositeInputProducts,
        background: backgroundToLegacyApi(bg),
        composition: composition as unknown as CompositeInputComp,
        imageSize: (state.imageQuality as '1K' | '2K' | '4K') ?? '1K',
      },
      seeds,
      { rembg: composition.rembg !== false },
    );
  };

  // Inline mapper — schema Background → composite API's expected
  // background shape. Lives here for now (Phase 2a touches one slice
  // only); when other slices migrate, this consolidates into
  // wizard/api-mappers.ts toCompositeRequest.
  function backgroundToLegacyApi(bg: Background): CompositeInput['background'] {
    switch (bg.kind) {
      case 'preset':
        return { source: 'preset', preset: bg.presetId };
      case 'upload':
        return {
          source: 'upload',
          uploadPath: isServerAsset(bg.asset) ? bg.asset.path : null,
        };
      case 'url':
        return { source: 'url' as const };
      case 'prompt':
        return { source: 'prompt', prompt: bg.prompt };
    }
  }

  const selectComposite = (v: CompositionVariant) => {
    const imageId = v.imageId ?? imageIdFromPath(v.path);
    update((s) => ({
      ...s,
      composition: {
        ...(s.composition ?? {}),
        generated: true,
        selectedSeed: v.seed,
        selectedPath: v.path ?? null,
        selectedUrl: v.url ?? null,
        selectedImageId: imageId,
      },
    }));
    if (imageId) {
      selectCompositeApi(imageId).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('composite select sync failed (non-fatal):', e);
      });
    }
  };

  const handlePickedServerFile = (f: unknown) => {
    if (pickerFor === 'bg') {
      // ServerFilePicker hands back { filename, path, url, ... } — convert
      // to a schema Background of kind 'upload' with a ServerAsset.
      const file = f as { filename?: string; path: string; url?: string };
      setBg({
        kind: 'upload',
        asset: { path: file.path, url: file.url, name: file.filename },
      });
    } else if (pickerFor === 'products') {
      setProducts((ps) => applyPickedFileToProducts(ps, f));
    }
    setPickerFor(null);
  };

  const selectedImageId =
    (composition as { selectedImageId?: string | null }).selectedImageId ??
    imageIdFromPath((composition as { selectedPath?: string | null }).selectedPath);

  return (
    <div className="step-page-split step-page-split--50-50">
      <div className="step-page-form">
        <StepHeading
          step={2}
          title="제품과 배경 합성하기"
          description="쇼호스트·제품·배경을 한 장의 사진으로 합쳐요. 이 스틸 이미지가 다음 단계(음성·영상)의 바탕이 돼요."
          eyebrow="영상 위저드"
        />


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

      <ServerFilePicker
        open={pickerFor !== null}
        kind="image"
        onClose={() => setPickerFor(null)}
        onSelect={handlePickedServerFile}
      />
      </div>

      {/* RIGHT — composite canvas. Final picked composite shows as the
       * apex 9:16 still; variants strip below for picking from the
       * just-generated batch. Codex framing: "scene staging — canvas
       * primary, controls contextual". Direct-manipulation chips
       * (배경 교체 / 다시 합성 / 제품 더 크게) is a follow-up; this
       * iteration just makes the canvas the visual primary. */}
      <div className="step-page-canvas">
        <CompositeCanvas
          composition={composition}
          variants={gen.variants}
          prevSelected={gen.prevSelected}
          selectedImageId={selectedImageId}
          isLoading={gen.isLoading}
          onSelect={selectComposite}
          onRegenerate={generate}
          canRegenerate={canGenerate}
        />
      </div>
    </div>
  );
}

interface CompositeCanvasProps {
  composition: Composition & { generated?: boolean; selectedUrl?: string | null };
  variants: CompositionVariant[];
  prevSelected: CompositionVariant | null;
  selectedImageId: string | null;
  isLoading: boolean;
  onSelect: (v: CompositionVariant) => void;
  onRegenerate: () => void;
  canRegenerate: boolean;
}

function CompositeCanvas({
  composition,
  variants,
  prevSelected,
  selectedImageId,
  isLoading,
  onSelect,
  onRegenerate,
  canRegenerate,
}: CompositeCanvasProps) {
  const empty = !isLoading && variants.length === 0 && !composition.generated;
  const heroUrl = composition.selectedUrl;

  return (
    <section className="composite-canvas">
      <header className="composite-canvas__header">
        <span className="composite-canvas__eyebrow">합성 결과</span>
        <h2 className="composite-canvas__title">
          {empty
            ? '합성한 결과가 여기 나와요'
            : isLoading && variants.length === 0
              ? '배경·제품·쇼호스트를 합성하는 중이에요'
              : composition.generated
                ? '선택한 결과 · 다른 후보를 골라도 돼요'
                : '마음에 드는 후보를 클릭해주세요'}
        </h2>
      </header>

      {empty ? (
        <div className="composite-canvas__empty">
          <ImageIcon className="size-6" strokeWidth={1.4} />
          <p className="composite-canvas__empty-line">
            왼쪽에서 제품·배경을 정하고{'\n'}합성하기를 눌러주세요
          </p>
        </div>
      ) : heroUrl ? (
        <figure className="composite-canvas__hero">
          <img src={heroUrl} alt="선택된 합성" className="composite-canvas__img" />
        </figure>
      ) : null}

      {variants.length > 0 && (
        <div className="composite-canvas__variants">
          <CompositionVariants
            variants={variants}
            prevSelected={prevSelected}
            selectedImageId={selectedImageId}
            onSelect={onSelect}
          />
        </div>
      )}

      {composition.generated && (
        <footer className="composite-canvas__footer">
          <Badge variant="success" icon="check_circle">
            합성 완료 · 다음 단계로
          </Badge>
          <Button size="sm" icon="refresh" onClick={onRegenerate} disabled={!canRegenerate}>
            다시 합성
          </Button>
        </footer>
      )}
    </section>
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
