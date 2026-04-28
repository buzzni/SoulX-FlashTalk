/**
 * Step2Composite — wizard Step 2 container.
 *
 * Owns a react-hook-form instance whose values span three store
 * slices: `products`, `background`, and `composition.settings`.
 * `composition.generation` (the SSE-driven state machine) is owned
 * by the store and never enters the form.
 *
 * Sync flow mirrors Step1Host:
 *   - store → form: a synthetic slice memo combines the three form-
 *     owned values (products, background, composition.settings — NOT
 *     composition.generation); useFormZustandSync resets the form
 *     when any reference changes. Subscribing to settings only (not
 *     the whole composition) keeps streaming candidate events from
 *     wiping in-progress edits.
 *   - form → store: useDebouncedFormSync flushes once per 300ms idle
 *     window; the onChange does ONE updateState call so subscribers
 *     see one render, one selector run.
 *
 * Mode swaps inside Background and per-product source kind go through
 * the form via setValue, then debounce-flush back to the store. The
 * tagged-union shape replacement is whole-object so invalid combos
 * (preset + url + prompt set together) are impossible.
 *
 * Generation triggers go through form.handleSubmit so a click inside
 * the 300ms debounce window still gets the latest validated values.
 * Eager uploads of LocalAsset products / background fire INSIDE submit
 * before the API call; the upload completion is written back to the
 * form via setValue so the persisted shape reflects the server paths.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { WizardBadge as Badge } from '@/components/wizard-badge';
import { WizardButton as Button } from '@/components/wizard-button';
import { WizardCard as Card } from '@/components/wizard-card';
import ServerFilePicker from '../ServerFilePicker.jsx';
import { applyPickedFileToProducts } from '../picker_handler.js';
import { useCompositeGeneration, type CompositionVariant } from '../../hooks/useCompositeGeneration';
import { useUploadReferenceImage } from '../../hooks/useUploadReferenceImage';
import { uploadBackgroundImage, uploadReferenceImage } from '../../api/upload';
import { selectComposite as selectCompositeApi } from '../../api/composite';
import { makeRandomSeeds } from '../../api/mapping';
import { useWizardStore } from '../../stores/wizardStore';
import { ProductList } from './ProductList';
import { BackgroundPicker } from './BackgroundPicker';
import { CompositionControls } from './CompositionControls';
import { CompositionVariants } from './CompositionVariants';
import { StepHeading } from '@/routes/StepHeading';
import type {
  Background,
  Composition,
  CompositionVariant as SchemaCompositionVariant,
  ImageQuality,
  Product,
  Products,
} from '@/wizard/schema';
import { isBackgroundReady } from '@/wizard/schema';
import { isLocalAsset } from '@/wizard/normalizers';
import { toCompositeRequest } from '@/wizard/api-mappers';
import { Step2FormValuesSchema, type Step2FormValues } from '@/wizard/form-mappers';
import { useFormZustandSync } from '@/hooks/wizard/useFormZustandSync';
import { useDebouncedFormSync } from '@/hooks/wizard/useDebouncedFormSync';

const identity = (s: Step2FormValues): Step2FormValues => s;

export interface Step2CompositeProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
}

export default function Step2Composite({ state }: Step2CompositeProps) {
  const products = useWizardStore((s) => s.products);
  const background = useWizardStore((s) => s.background);
  const composition = useWizardStore((s) => s.composition);
  // Settings is the only composition sub-slice the form owns.
  // Subscribing at this granularity prevents SSE candidate events
  // (which mutate composition.generation) from triggering a form
  // reset that would wipe in-progress edits to direction/shot/angle.
  const settings = useWizardStore((s) => s.composition.settings);
  const updateState = useWizardStore((s) => s.updateState);
  // selectComposite touches only composition.generation; bypasses the
  // form (the form doesn't own lifecycle). setComposition stays for
  // that one path.
  const setComposition = useWizardStore((s) => s.setComposition);
  const imageQuality: ImageQuality = (state.imageQuality as ImageQuality) || '1K';

  const gen = useCompositeGeneration();
  const regenerate = gen.regenerate;
  const productUpload = useUploadReferenceImage(uploadReferenceImage);
  const backgroundUpload = useUploadReferenceImage(uploadBackgroundImage);
  const attemptsRef = useRef<number>(composition.generation.state === 'ready' ? 1 : 0);
  const [pickerFor, setPickerFor] = useState<'products' | 'bg' | null>(null);

  // Form-shaped projection. Memo keys on the three sub-slice refs
  // (settings instead of composition) so streaming candidate events
  // can't blow away the form. `useFormZustandSync` triggers `form.reset`
  // when this ref changes; with a hard reset (`keepDirty:false`, see
  // useFormZustandSync.ts memory) we MUST keep the deps narrow.
  const sliceValues = useMemo<Step2FormValues>(
    () => ({ products, background, settings }),
    [products, background, settings],
  );

  const form = useForm<Step2FormValues>({
    resolver: zodResolver(Step2FormValuesSchema),
    defaultValues: sliceValues,
    mode: 'onBlur',
  });

  useFormZustandSync(form, sliceValues, identity);

  // Single `updateState` call batches the three sub-slice writes — one
  // zustand `set`, one re-render, one selector run per subscriber per
  // debounce flush. composition.generation passes through prev so the
  // streaming state machine isn't disturbed.
  const onChange = useCallback(
    (values: Step2FormValues) => {
      updateState((s) => ({
        products: values.products,
        background: values.background,
        composition: { ...s.composition, settings: values.settings },
      }));
    },
    [updateState],
  );
  useDebouncedFormSync(form, onChange, 300);

  // Live values for derived UI state. Reading from the form keeps the
  // editor swap instantaneous; the store sync is debounced 300ms behind.
  const watchedBackground = form.watch('background');
  const watchedProducts = form.watch('products');
  const bgReady = isBackgroundReady(watchedBackground);
  const productsReady =
    watchedProducts.length > 0 && watchedProducts.some((p) => p.source.kind !== 'empty');
  const canGenerate = bgReady && productsReady;
  const missingReason = !canGenerate
    ? `${!productsReady ? '제품 사진을 먼저 올려주세요. ' : ''}${!bgReady ? '배경을 선택해주세요.' : ''}`
    : null;

  const submit = useMemo(
    () =>
      form.handleSubmit(async (values) => {
        const attempt = attemptsRef.current;
        const seeds = attempt === 0 ? undefined : makeRandomSeeds(4);
        attemptsRef.current = attempt + 1;

        // Product + background uploads are independent — fire them in
        // parallel. Stale-result rejection inside useUploadReferenceImage
        // means a late response can't overwrite a newer pick.
        const productJobs = values.products.map(async (p): Promise<Product> => {
          if (p.source.kind !== 'localFile') return p;
          const r = await productUpload.upload(p.source.asset.file);
          if (!r?.path) return p;
          return {
            ...p,
            source: {
              kind: 'uploaded',
              asset: { path: r.path, url: r.url, name: p.source.asset.name },
            },
          };
        });
        const bgJob: Promise<Background> = (async () => {
          if (values.background.kind !== 'upload' || !isLocalAsset(values.background.asset)) {
            return values.background;
          }
          const r = await backgroundUpload.upload(values.background.asset.file);
          if (!r?.path) return values.background;
          return {
            kind: 'upload',
            asset: { path: r.path, url: r.url, name: values.background.asset.name },
          };
        })();
        const [uploadedProducts, uploadedBg] = await Promise.all([
          Promise.all(productJobs),
          bgJob,
        ]);

        // Reflect upload results in form state (and downstream store).
        form.setValue('products', uploadedProducts, { shouldDirty: true });
        if (uploadedBg !== values.background) {
          form.setValue('background', uploadedBg, { shouldDirty: true });
        }

        const apiInput = toCompositeRequest({
          host: state.host,
          products: uploadedProducts,
          background: uploadedBg,
          composition: { ...composition, settings: values.settings },
          imageQuality,
        });
        await regenerate(apiInput, seeds, { rembg: values.settings.rembg });
      }),
    [
      form,
      productUpload,
      backgroundUpload,
      regenerate,
      state.host,
      composition,
      imageQuality,
    ],
  );

  const selectComposite = (v: CompositionVariant) => {
    if (!v.url || !v.path || !v.imageId) return;
    const imageId = v.imageId;
    setComposition((prev) => {
      if (prev.generation.state !== 'ready' && prev.generation.state !== 'streaming') return prev;
      const variants = prev.generation.state === 'ready' ? prev.generation.variants : [];
      const prevSelected = prev.generation.state === 'ready' ? prev.generation.prevSelected : null;
      const selected: SchemaCompositionVariant = {
        seed: v.seed,
        imageId,
        url: v.url as string,
        path: v.path as string,
      };
      return {
        ...prev,
        generation: {
          state: 'ready',
          batchId: prev.generation.state === 'ready' ? prev.generation.batchId : null,
          variants,
          selected,
          prevSelected,
        },
      };
    });
    selectCompositeApi(imageId).catch((e) => {
      console.warn('composite select sync failed (non-fatal):', e);
    });
  };

  const handlePickedServerFile = (f: unknown) => {
    if (pickerFor === 'bg') {
      const file = f as { filename?: string; path: string; url?: string };
      form.setValue(
        'background',
        { kind: 'upload', asset: { path: file.path, url: file.url, name: file.filename } },
        { shouldDirty: true, shouldValidate: true },
      );
    } else if (pickerFor === 'products') {
      const next = applyPickedFileToProducts(form.getValues('products'), f);
      form.setValue('products', next as Products, { shouldDirty: true, shouldValidate: true });
    }
    setPickerFor(null);
  };

  const selectedImageId =
    composition.generation.state === 'ready' && composition.generation.selected
      ? composition.generation.selected.imageId
      : null;

  const addEmptyProduct = () => {
    const next: Products = [
      ...form.getValues('products'),
      { id: Date.now().toString(36), source: { kind: 'empty' } },
    ];
    form.setValue('products', next, { shouldDirty: true });
  };

  return (
    <FormProvider {...form}>
      <div className="step-page-split step-page-split--50-50">
        <div className="step-page-form">
          <StepHeading
            step={2}
            title="제품과 배경 합성하기"
            description="이 한 장이 다음 단계 음성·영상의 바탕이 돼요"
            eyebrow="영상 위저드"
          />

          <Card
            title="소개할 상품"
            action={
              <div className="flex gap-1.5">
                <Button icon="file" size="sm" onClick={() => setPickerFor('products')}>
                  서버 파일 선택
                </Button>
                <Button icon="plus" size="sm" onClick={addEmptyProduct}>
                  제품 추가
                </Button>
              </div>
            }
          >
            <ProductList />
          </Card>

          <Card title="배경">
            <BackgroundPicker onPickServerFile={() => setPickerFor('bg')} />
          </Card>

          <Card title="구도" subtitle="쇼호스트 자세·제품 위치를 적어주세요">
            <CompositionControls
              generating={gen.isLoading}
              errorMsg={gen.error}
              canGenerate={canGenerate}
              missingReason={missingReason}
              onGenerate={submit}
            />
          </Card>

          <ServerFilePicker
            open={pickerFor !== null}
            kind="image"
            onClose={() => setPickerFor(null)}
            onSelect={handlePickedServerFile}
          />
        </div>

        <div className="step-page-canvas">
          <CompositeCanvas
            composition={composition}
            variants={gen.variants}
            prevSelected={gen.prevSelected}
            selectedImageId={selectedImageId}
            isLoading={gen.isLoading}
            onSelect={selectComposite}
            onRegenerate={submit}
            canRegenerate={canGenerate}
          />
        </div>
      </div>
    </FormProvider>
  );
}

interface CompositeCanvasProps {
  composition: Composition;
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
  const selected =
    composition.generation.state === 'ready' ? composition.generation.selected : null;
  const hasSelection = selected !== null;
  const empty = !isLoading && variants.length === 0 && !hasSelection;
  const heroUrl = selected ? selected.url : null;

  return (
    <section className="composite-canvas">
      <header className="composite-canvas__header">
        <span className="composite-canvas__eyebrow">합성 결과</span>
        <h2 className="composite-canvas__title">
          {empty
            ? '합성한 결과가 여기 나와요'
            : isLoading && variants.length === 0
              ? '배경·제품·쇼호스트를 합성하는 중이에요'
              : hasSelection
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

      {hasSelection && (
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
