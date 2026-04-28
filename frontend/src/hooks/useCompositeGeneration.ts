/**
 * useCompositeGeneration — SSE-driven composite candidate generation
 * with slot-aware state.
 *
 * Mirror of `useHostGeneration` (Phase 2b), now driving the schema's
 * `composition.generation` state machine (idle | streaming | ready |
 * failed). Local UI variant type with placeholder/error fields for
 * mid-stream rendering; schema's stable CompositionVariant lives in
 * the persisted slice.
 */

import { useCallback, useState } from 'react';
import { streamComposite, type CompositeInput } from '../api/composite';
import { humanizeError } from '../api/http';
import { imageIdFromPath } from '../api/mapping';
import { useWizardStore } from '../stores/wizardStore';
import { useAbortableRequest } from './useAbortableRequest';
import type { CompositionVariant as SchemaCompositionVariant } from '../wizard/schema';

/** UI/transient streaming variant. Carries placeholder/error for
 * mid-stream rendering. */
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

function liftSchemaVariant(v: SchemaCompositionVariant): CompositionVariant {
  return {
    seed: v.seed,
    id: `c${v.seed}`,
    imageId: v.imageId,
    url: v.url,
    path: v.path,
    placeholder: false,
  };
}

function lowerToSchema(variants: CompositionVariant[]): SchemaCompositionVariant[] {
  return variants
    .filter((v) => !v.placeholder && !v.error && v.url && v.path && v.imageId)
    .map((v) => ({
      seed: v.seed,
      imageId: v.imageId as string,
      url: v.url as string,
      path: v.path as string,
    }));
}

function readInitialFromStore(): {
  variants: CompositionVariant[];
  prevSelected: CompositionVariant | null;
  batchId: string | null;
} {
  // v9 (streaming-resume Phase B): mirrors useHostGeneration's
  // readInitialFromStore — the schema no longer carries variants/
  // selected/batchId, those resolve via jobCacheStore (step 14) once
  // step 17 swaps this hook to a store selector.
  return { variants: [], prevSelected: null, batchId: null };
}

export function useCompositeGeneration(): UseCompositeGenerationReturn {
  const initial = readInitialFromStore();
  const [variants, setVariants] = useState<CompositionVariant[]>(initial.variants);
  const [prevSelected, setPrevSelected] = useState<CompositionVariant | null>(initial.prevSelected);
  const [batchId, setBatchId] = useState<string | null>(initial.batchId);
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

      const comp = {
        ...(input.composition ?? {}),
        ...(input.imageSize ? { imageSize: input.imageSize } : {}),
        ...(seeds ? { _seeds: seeds } : {}),
      };
      const req: CompositeInput = { ...input, composition: comp };

      setIsLoading(true);
      setError(null);
      setVariants([]);

      // v9: schema-side prev_selected and store transitions are gone
      // (step 17 sources them from jobCacheStore instead). Hook-local
      // state carries the SSE progression for the current session.
      const seedPrev: CompositionVariant | null = null;
      setPrevSelected(seedPrev);

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
            // direction_en (backend's English-translated direction) is
            // a debug field — drop on persist; not modeled in schema.
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
            // v9: per-candidate progress stays hook-local — see
            // useHostGeneration for the rationale.
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
            // v9: terminal state lives server-side. Step 17 sources
            // variants/selected/prevSelected via jobCacheStore.
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
        const msg = humanizeError(err);
        setError(msg);
        // v9: failure persists on the server's generation_jobs row;
        // schema's composition.generation stays idle.
      }
    },
    [run],
  );

  return { variants, prevSelected, batchId, isLoading, error, regenerate, abort };
}
