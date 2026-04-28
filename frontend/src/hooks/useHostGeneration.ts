/**
 * useHostGeneration — SSE-driven host candidate generation with
 * slot-aware state.
 *
 * The backend emits 5 event flavors during a stream:
 *   - `init` — accepted + echoes the seeds it will use. ONLY after
 *     this do we draw placeholder tiles. (Drawing them before init
 *     meant a validation failure left 4 spinners stuck on screen.)
 *   - `candidate` — one slot completed. Has seed + url + path.
 *   - `error` — per-slot failure. Mark that slot as errored.
 *   - `fatal` — stream aborted backend-side. Rethrow.
 *   - `done` — terminal. If min_success_met is false, throw.
 *
 * Variants have matching `seed` identity so out-of-order candidate
 * events land in the right tile. UI never sees intermediate
 * un-init'd placeholders.
 *
 * Phase 2b: schema-typed. The store holds `host.generation` (state
 * machine: idle | streaming | ready | failed) — this hook drives the
 * transitions. The hook itself keeps a local `HostVariantUI` type
 * with placeholder/error fields for mid-stream UI; only completed
 * variants get committed to the schema's `HostVariant`.
 */

import { useCallback, useState } from 'react';
import { streamHost, type HostGenerateInput } from '../api/host';
import { humanizeError } from '../api/http';
import { imageIdFromPath } from '../api/mapping';
import { useWizardStore } from '../stores/wizardStore';
import { useAbortableRequest } from './useAbortableRequest';
import type { HostVariant as SchemaHostVariant } from '../wizard/schema';

/** UI/transient streaming variant shape. Carries placeholder/error
 * for mid-stream rendering — the schema's stable HostVariant is the
 * sub-shape that survives to persistence. */
export interface HostVariant {
  seed: number;
  id: string;
  imageId?: string | null;
  url?: string;
  path?: string;
  placeholder: boolean;
  error?: string;
  /** True for the 5th "이전 선택" tile carried over from a prior batch. */
  isPrev?: boolean;
  _gradient?: string | null;
}

export interface UseHostGenerationReturn {
  variants: HostVariant[];
  prevSelected: HostVariant | null;
  batchId: string | null;
  isLoading: boolean;
  error: string | null;
  regenerate: (
    input: HostGenerateInput & { imageSize?: '1K' | '2K' | '4K' },
    seeds?: number[],
  ) => Promise<void>;
  abort: () => void;
}

/** Schema HostVariant → UI HostVariant (add placeholder=false). */
function liftSchemaVariant(v: SchemaHostVariant): HostVariant {
  return {
    seed: v.seed,
    id: `v${v.seed}`,
    imageId: v.imageId,
    url: v.url,
    path: v.path,
    placeholder: false,
  };
}

/** UI HostVariant (filter to non-placeholder, non-error) → schema. */
function lowerToSchema(variants: HostVariant[]): SchemaHostVariant[] {
  return variants
    .filter((v) => !v.placeholder && !v.error && v.url && v.path && v.imageId)
    .map((v) => ({
      seed: v.seed,
      imageId: v.imageId as string,
      url: v.url as string,
      path: v.path as string,
    }));
}

/** Seed initial UI state from the current store host slice.
 *
 * v9 (streaming-resume Phase B): the schema no longer carries
 * variants/selected/batchId. Step 17 will rehydrate from jobCacheStore
 * via the host.generation.attached.jobId handle. Until then, return
 * empty state — reload mid-generation reverts to a blank grid (the
 * trade-off the broader refactor accepts in exchange for race-free
 * server-side truth). */
function readInitialFromStore(): {
  variants: HostVariant[];
  prevSelected: HostVariant | null;
  batchId: string | null;
} {
  return { variants: [], prevSelected: null, batchId: null };
}

export function useHostGeneration(): UseHostGenerationReturn {
  const initial = readInitialFromStore();
  const [variants, setVariants] = useState<HostVariant[]>(initial.variants);
  const [prevSelected, setPrevSelected] = useState<HostVariant | null>(initial.prevSelected);
  const [batchId, setBatchId] = useState<string | null>(initial.batchId);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { run, abort } = useAbortableRequest();

  const regenerate = useCallback(
    async (
      input: HostGenerateInput & { imageSize?: '1K' | '2K' | '4K' },
      seeds?: number[],
    ): Promise<void> => {
      const { signal, isCurrent } = run();
      const req: HostGenerateInput = seeds ? { ...input, _seeds: seeds } : input;

      setIsLoading(true);
      setError(null);
      setVariants([]);

      // v9: no schema-side selected/variants. Step 17 will source the
      // previous selection from jobCacheStore + a host.selected field.
      // Until then, prev tile is null and persisted generation stays idle.
      const seedPrev: HostVariant | null = null;
      setPrevSelected(seedPrev);

      // The store's generation state stays idle through this transitional
      // phase — step 17 will swap to attached(jobId) once the new POST
      // /api/jobs path is wired in. SSE progress is tracked entirely via
      // hook-local React state in the meantime (reload-lossy, fixed in
      // step 17).

      let currentVariants: HostVariant[] = [];
      let currentPrev: HostVariant | null = seedPrev;
      let currentBatchId: string | null = null;
      const errs: string[] = [];
      let errorCount = 0;

      try {
        for await (const evt of streamHost(req, { signal })) {
          if (!isCurrent()) return;

          if (evt.type === 'init') {
            const slotSeeds =
              Array.isArray(evt.seeds) && evt.seeds.length > 0
                ? (evt.seeds as number[])
                : (seeds ?? []);
            currentVariants = slotSeeds.map((s) => ({
              seed: s,
              id: `v${s}`,
              placeholder: true,
            }));
            setVariants(currentVariants);
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
            // v9: don't mirror per-candidate state into the store; the
            // store carries only the {idle | attached(jobId)} handle and
            // step 17 will route progress through jobCacheStore.
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
              const err = new Error(`후보가 부족해요 (${successCount}/${total})`);
              (err as { status?: number }).status = 503;
              throw err;
            }
            if (errorCount > 0) {
              // eslint-disable-next-line no-console
              console.warn('host generate had partial errors:', errs);
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

            // v9: terminal state lives on the server. Don't persist
            // variants/selected/prevSelected into the schema — step 17
            // will derive them from jobCacheStore.
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
        // v9: failure state lives on the server's generation_jobs row;
        // the schema's host.generation stays idle. Hook-local `error`
        // surfaces to the UI for the current session.
      }
    },
    [run],
  );

  return { variants, prevSelected, batchId, isLoading, error, regenerate, abort };
}
