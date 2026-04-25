/**
 * useCompositeGeneration — SSE-driven composite (host × products ×
 * background) candidate generation with slot-aware state.
 *
 * Mirror of `useHostGeneration` with the same event vocabulary
 * (init / candidate / error / fatal / done) and the same slot
 * tracking by seed. Final set persists to
 * `wizardStore.composition.variants` (Decision #1).
 *
 * See `useHostGeneration` header for the canonical contract doc.
 */

import { useCallback, useState } from 'react';
import { streamComposite, type CompositeInput } from '../api/composite';
import { humanizeError } from '../api/http';
import { imageIdFromPath } from '../api/mapping';
import { useWizardStore } from '../stores/wizardStore';
import { useAbortableRequest } from './useAbortableRequest';

export interface CompositionVariant {
  seed: number;
  id: string;
  imageId?: string | null;
  url?: string;
  path?: string;
  placeholder: boolean;
  error?: string;
  /** True for the 5th "이전 선택" tile carried over from a prior batch. */
  isPrev?: boolean;
}

export interface UseCompositeGenerationOptions {
  /** Backend runs rembg background removal by default; pass `false`
   * to skip. */
  rembg?: boolean;
}

export interface UseCompositeGenerationReturn {
  variants: CompositionVariant[];
  prevSelected: CompositionVariant | null;
  batchId: string | null;
  isLoading: boolean;
  error: string | null;
  regenerate: (
    input: CompositeInput & { imageSize?: '1K' | '2K' | '4K'; _seeds?: number[] },
    seeds?: number[],
    opts?: UseCompositeGenerationOptions,
  ) => Promise<void>;
  abort: () => void;
}

export function useCompositeGeneration(): UseCompositeGenerationReturn {
  const initialComp = (useWizardStore.getState().composition ?? {}) as Record<string, unknown>;
  const initialVariants = (initialComp.variants as CompositionVariant[] | undefined) ?? [];
  const initialPrev = (initialComp.prevSelected as CompositionVariant | null | undefined) ?? null;
  const initialBatchId = (initialComp.batchId as string | null | undefined) ?? null;

  const [variants, setVariants] = useState<CompositionVariant[]>(initialVariants);
  const [prevSelected, setPrevSelected] = useState<CompositionVariant | null>(initialPrev);
  const [batchId, setBatchId] = useState<string | null>(initialBatchId);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { run, abort } = useAbortableRequest();

  const regenerate = useCallback(
    async (
      input: CompositeInput & { imageSize?: '1K' | '2K' | '4K'; _seeds?: number[] },
      seeds?: number[],
      opts: UseCompositeGenerationOptions = {},
    ): Promise<void> => {
      const { signal, isCurrent } = run();

      // Thread `imageSize` + optional `_seeds` through the composition
      // sub-object (that's where buildCompositeBody picks them up).
      const comp = {
        ...(input.composition ?? {}),
        ...(input.imageSize ? { imageSize: input.imageSize } : {}),
        ...(seeds ? { _seeds: seeds } : {}),
      };
      const req: CompositeInput = { ...input, composition: comp };

      setIsLoading(true);
      setError(null);
      setVariants([]);

      // Eager-persist a prev_selected from the about-to-be-replaced
      // selection so a mid-stream navigation preserves the prev tile.
      const storeCompBefore = (useWizardStore.getState().composition ?? {}) as Record<string, unknown>;
      const oldSelectedPath = storeCompBefore.selectedPath as string | null | undefined;
      const oldSelectedUrl = storeCompBefore.selectedUrl as string | null | undefined;
      const oldSelectedSeed = storeCompBefore.selectedSeed as number | null | undefined;
      const oldSelectedImageId =
        (storeCompBefore.selectedImageId as string | null | undefined) ??
        (oldSelectedPath ? imageIdFromPath(oldSelectedPath) : undefined);
      const seedPrev: CompositionVariant | null =
        oldSelectedPath && oldSelectedUrl && oldSelectedImageId
          ? {
              seed: typeof oldSelectedSeed === 'number' ? oldSelectedSeed : -1,
              id: `prev-${oldSelectedImageId}`,
              imageId: oldSelectedImageId,
              url: oldSelectedUrl,
              path: oldSelectedPath,
              placeholder: false,
              isPrev: true,
            }
          : null;
      setPrevSelected(seedPrev);
      useWizardStore.getState().setComposition({
        variants: [],
        prevSelected: seedPrev,
        batchId: null,
      });

      let currentVariants: CompositionVariant[] = [];
      let currentPrev: CompositionVariant | null = seedPrev;
      let currentBatchId: string | null = null;
      let errorCount = 0;
      const errs: string[] = [];

      try {
        for await (const evt of streamComposite(req, { signal, rembg: opts.rembg ?? true })) {
          if (!isCurrent()) return;

          if (evt.type === 'init') {
            const slotSeeds =
              Array.isArray(evt.seeds) && evt.seeds.length > 0
                ? (evt.seeds as number[])
                : (seeds ?? []);
            currentVariants = slotSeeds.map((s) => ({
              seed: s,
              id: `c${s}`,
              placeholder: true,
            }));
            setVariants(currentVariants);

            // The backend also echoes back the English-translated
            // direction via init — cache so Phase 5 debug UIs can
            // display "what the model actually saw."
            if (typeof evt.direction_en === 'string') {
              useWizardStore
                .getState()
                .setComposition({ direction_en: evt.direction_en });
            }
          } else if (evt.type === 'candidate') {
            const path = evt.path as string;
            currentVariants = currentVariants.map((v) =>
              v.seed === evt.seed
                ? {
                    ...v,
                    url: evt.url as string,
                    path,
                    imageId: imageIdFromPath(path),
                    placeholder: false,
                  }
                : v,
            );
            setVariants(currentVariants);
            // Strip placeholders so a remount won't render dead spinners.
            useWizardStore.getState().setComposition({
              variants: currentVariants.filter((v) => !v.placeholder && !v.error),
            });
          } else if (evt.type === 'error') {
            errorCount += 1;
            const detail = typeof evt.error === 'string' ? evt.error : 'unknown';
            errs.push(`seed ${evt.seed}: ${detail}`);
            currentVariants = currentVariants.map((v) =>
              v.seed === evt.seed ? { ...v, error: detail, placeholder: false } : v,
            );
            setVariants(currentVariants);
          } else if (evt.type === 'fatal') {
            const err = new Error(
              (typeof evt.error === 'string' && evt.error) || '알 수 없는 오류',
            );
            (err as { status?: number }).status = evt.status as number | undefined;
            throw err;
          } else if (evt.type === 'done') {
            if (evt.min_success_met === false) {
              const successCount = currentVariants.filter(
                (v) => !v.placeholder && !v.error,
              ).length;
              const total = (evt.total as number | undefined) ?? currentVariants.length;
              const err = new Error(`합성 후보가 부족해요 (${successCount}/${total})`);
              (err as { status?: number }).status = 503;
              throw err;
            }
            if (errorCount > 0) {
              // eslint-disable-next-line no-console
              console.warn('composite had partial errors:', errs);
            }
            if (typeof evt.batch_id === 'string') {
              currentBatchId = evt.batch_id;
              setBatchId(currentBatchId);
            }
            const prevRaw = evt.prev_selected as
              | { image_id?: string; path?: string; url?: string; seed?: number; batch_id?: string }
              | null
              | undefined;
            if (prevRaw && prevRaw.image_id && prevRaw.url) {
              currentPrev = {
                seed: typeof prevRaw.seed === 'number' ? prevRaw.seed : -1,
                id: `prev-${prevRaw.image_id}`,
                imageId: prevRaw.image_id,
                url: prevRaw.url,
                path: prevRaw.path,
                placeholder: false,
                isPrev: true,
              };
            } else {
              currentPrev = null;
            }
            setPrevSelected(currentPrev);
            useWizardStore.getState().setComposition({
              variants: currentVariants,
              prevSelected: currentPrev,
              batchId: currentBatchId,
            });
          }
        }

        if (!isCurrent()) return;
        setIsLoading(false);
      } catch (err) {
        if (!isCurrent()) return;
        const name = (err as { name?: string } | null)?.name;
        if (name === 'AbortError') {
          setIsLoading(false);
          return;
        }
        setIsLoading(false);
        setError(humanizeError(err));
      }
    },
    [run],
  );

  return { variants, prevSelected, batchId, isLoading, error, regenerate, abort };
}
