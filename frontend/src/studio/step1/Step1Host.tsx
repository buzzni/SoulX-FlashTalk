/**
 * Step1Host — wizard Step 1 container.
 *
 * The host slice in the store is now
 *   { input: HostInput (text | image union), temperature, generation }
 *
 * This file owns a react-hook-form instance whose values are the
 * `HostFormValues` projection (everything except `generation`). The
 * helpers `useFormZustandSync` + `useDebouncedFormSync` keep the form
 * and the store in lockstep:
 *
 *   - store → form: a slice reference change (mode switch, variant
 *     selection, generation completion) triggers `form.reset()`.
 *   - form → store: every input change debounces 300ms then writes
 *     the slice via `setHost((prev) => formValuesToHostSlice(v, prev))`.
 *     Generation lifecycle on `prev` is preserved on every write.
 *
 * Mode switching is one-directional: `switchMode` writes to the store,
 * the slice reference changes, and `useFormZustandSync` propagates
 * the new tagged shape into the form via `form.reset`.
 *
 * Generation triggers go through `form.handleSubmit` so the latest
 * (validated) form values reach the API mapper, even if the user clicks
 * "쇼호스트 만들기" inside the 300ms debounce window.
 *
 * Children (HostTextForm, HostReferenceUploader, HostControls) read
 * from `useFormContext` instead of value/onChange props.
 */

import { useCallback, useMemo, useRef } from 'react';
import { ImageOff } from 'lucide-react';
import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { WizardBadge as Badge } from '@/components/wizard-badge';
import { WizardButton as Button } from '@/components/wizard-button';
import { WizardCard as Card } from '@/components/wizard-card';
import { Segmented } from '@/components/segmented';
import { StepHeading } from '@/routes/StepHeading';
import { useHostGeneration, type HostVariant } from '../../hooks/useHostGeneration';
import { makeRandomSeeds } from '../../api/mapping';
import { selectHost } from '../../api/host';
import { useWizardStore } from '../../stores/wizardStore';
import { INITIAL_HOST, type HostInput, type ImageQuality } from '@/wizard/schema';
import { toHostGenerateRequest } from '@/wizard/api-mappers';
import {
  HostFormValuesSchema,
  hostSliceToFormValues,
  formValuesToHostSlice,
  type HostFormValues,
} from '@/wizard/form-mappers';
import { useFormZustandSync } from '@/hooks/wizard/useFormZustandSync';
import { useDebouncedFormSync } from '@/hooks/wizard/useDebouncedFormSync';
import { HostTextForm } from './HostTextForm';
import { HostReferenceUploader } from './HostReferenceUploader';
import { HostControls } from './HostControls';
import { HostVariantGrid } from './HostVariantGrid';

const DEFAULT_SEEDS = [10, 42, 77, 128];

// Image-mode initial input. No equivalent in `INITIAL_HOST` (which is
// text-mode) — kept as a local constant so `switchMode` can swap the
// tagged-union shape atomically.
const IMAGE_INPUT_DEFAULTS: Extract<HostInput, { kind: 'image' }> = {
  kind: 'image',
  faceRef: null,
  outfitRef: null,
  outfitText: '',
  extraPrompt: '',
  faceStrength: 0.7,
  outfitStrength: 0.5,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UpdateFn = (updater: (state: any) => any) => void;

export interface Step1HostProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  update: UpdateFn;
}

export default function Step1Host({ state, update }: Step1HostProps) {
  const host = useWizardStore((s) => s.host);
  const setHost = useWizardStore((s) => s.setHost);
  const imageQuality: ImageQuality = (state.imageQuality as ImageQuality) || '1K';

  const gen = useHostGeneration();
  const regenerate = gen.regenerate;

  // Counts every "쇼호스트 만들기" press (incl. 다시 만들기). Attempt 0
  // uses DEFAULT_SEEDS; attempt 1+ uses fresh randoms.
  // v9: 'attached' (a job in flight or already finished on the server)
  // counts as a prior attempt; 'idle' means the user hasn't started.
  const attemptsRef = useRef<number>(
    host.generation.state === 'attached' ? 1 : 0,
  );

  const form = useForm<HostFormValues>({
    resolver: zodResolver(HostFormValuesSchema),
    defaultValues: hostSliceToFormValues(host),
    mode: 'onBlur',
  });

  useFormZustandSync(form, host, hostSliceToFormValues);

  const onChange = useCallback(
    (values: HostFormValues) => setHost((prev) => formValuesToHostSlice(values, prev)),
    [setHost],
  );
  useDebouncedFormSync(form, onChange, 300);

  // Read the live input from the form so editor swaps + readiness
  // checks reflect keystrokes immediately (the store sync is debounced
  // 300ms behind, so reading from `host` here would lag by one frame).
  const watchedInput = form.watch('input');
  const mode = watchedInput.kind;
  const promptReady =
    watchedInput.kind === 'text'
      ? watchedInput.prompt.length >= 15
      : watchedInput.faceRef !== null;

  const switchMode = (next: 'text' | 'image') => {
    if (host.input.kind === next) return;
    // One-direction: write the store. The slice reference changes →
    // useFormZustandSync calls form.reset with the new shape.
    setHost((prev) => ({
      ...prev,
      input: next === 'text' ? INITIAL_HOST.input : IMAGE_INPUT_DEFAULTS,
    }));
  };

  const submit = useMemo(
    () =>
      form.handleSubmit(async (values) => {
        const attempt = attemptsRef.current;
        const seeds = attempt === 0 ? DEFAULT_SEEDS : makeRandomSeeds(4);
        attemptsRef.current = attempt + 1;
        // Reuse the shared host slice → API mapper. `host` has the
        // generation lifecycle that the form omits; merging here keeps
        // the request shape consistent with all other host callers.
        // `regenerate` re-attaches `_seeds`, so don't pass it here.
        const apiInput = toHostGenerateRequest(
          formValuesToHostSlice(values, host),
          imageQuality,
        );
        // The mapper still emits the snake_case UI-side shape that the
        // legacy /api/host/generate/stream endpoint expected. The new
        // useHostGeneration hook accepts that shape and re-keys to the
        // /api/jobs body internally — see toHostJobInput in the hook.
        await regenerate(apiInput as unknown as Parameters<typeof regenerate>[0], attempt === 0 ? undefined : seeds);
      }),
    [form, host, imageQuality, regenerate],
  );

  const handleSelectVariant = (v: HostVariant) => {
    if (!v.imageId || !v.path || !v.url) return;
    const imageId = v.imageId;
    // v9: persist a snapshot of the chosen variant. Pure functions
    // like api-mappers + api/video read host.selected directly without
    // the jobCacheStore.
    setHost((prev) => ({
      ...prev,
      selected: { imageId, path: v.path!, url: v.url!, seed: v.seed },
    }));
    selectHost(imageId).catch((e) => {
      console.warn('host select sync failed (non-fatal):', e);
    });
  };

  const variants = gen.variants;
  const prevSelected = gen.prevSelected;
  const selectedImageId = host.selected?.imageId ?? null;
  const generated = host.selected !== null;

  return (
    <FormProvider {...form}>
      <div className="step-page-split step-page-split--40-60">
        <div className="step-page-form">
          <StepHeading
            step={1}
            title="쇼호스트 만들기"
            description="영상에 등장할 사람을 만들어요. 설명을 적거나 사진을 올려주세요."
            eyebrow="영상 위저드"
          />

          <Card>
            <div className="flex justify-between items-center">
              <Segmented
                value={mode}
                onChange={switchMode}
                options={[
                  { value: 'text', label: '설명으로 만들기', icon: 'wand' },
                  { value: 'image', label: '사진으로 만들기', icon: 'image' },
                ]}
              />
              <Badge variant="neutral" icon="info">
                4장을 비교해서 골라요
              </Badge>
            </div>

            {mode === 'text' ? <HostTextForm /> : <HostReferenceUploader />}

            <HostControls
              imageQuality={imageQuality}
              errorMsg={gen.error}
              generating={gen.isLoading}
              canGenerate={promptReady}
              onImageQualityChange={(v) =>
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                update((s: any) => ({ ...s, imageQuality: v }))
              }
              onGenerate={submit}
            />
          </Card>
        </div>

        <div className="step-page-canvas">
          <AuditionGallery
            mode={mode}
            variants={variants}
            prevSelected={prevSelected}
            selectedImageId={selectedImageId}
            isLoading={gen.isLoading}
            generated={generated}
            onSelect={handleSelectVariant}
            onRegenerate={submit}
          />
        </div>
      </div>
    </FormProvider>
  );
}

interface AuditionGalleryProps {
  mode: 'text' | 'image';
  variants: HostVariant[];
  prevSelected: HostVariant | null;
  selectedImageId: string | null;
  isLoading: boolean;
  generated: boolean;
  onSelect: (v: HostVariant) => void;
  onRegenerate: () => void;
}

function AuditionGallery({
  mode,
  variants,
  prevSelected,
  selectedImageId,
  isLoading,
  generated,
  onSelect,
  onRegenerate,
}: AuditionGalleryProps) {
  const empty = !isLoading && variants.length === 0;
  return (
    <section className="audition">
      <header className="audition__header">
        <span className="audition__eyebrow">오디션 결과</span>
        <h2 className="audition__title">
          {empty
            ? '쇼호스트 후보가 여기 나와요'
            : isLoading && variants.length === 0
              ? '후보를 만드는 중이에요'
              : `후보 ${variants.length}장 · 마음에 드는 한 명을 골라주세요`}
        </h2>
      </header>

      {empty ? (
        <div className="audition__empty">
          <ImageOff className="size-6" strokeWidth={1.4} />
          <p className="audition__empty-line">
            {mode === 'text'
              ? '왼쪽에 어떤 모습인지 적고\n쇼호스트 만들기를 눌러주세요'
              : '왼쪽에 얼굴·옷차림 사진을 올리고\n쇼호스트 만들기를 눌러주세요'}
          </p>
        </div>
      ) : (
        <>
          {variants.length > 0 && (
            <HostVariantGrid
              variants={variants}
              prevSelected={prevSelected}
              selectedImageId={selectedImageId}
              onSelect={onSelect}
            />
          )}
          {generated && (
            <footer className="audition__footer">
              <Badge variant="success" icon="check_circle">
                선택 완료 · 다음 단계로 넘어가세요
              </Badge>
              <Button size="sm" icon="refresh" onClick={onRegenerate}>
                다시 만들기
              </Button>
            </footer>
          )}
        </>
      )}
    </section>
  );
}
