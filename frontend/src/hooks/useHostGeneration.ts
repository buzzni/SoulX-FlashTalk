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
 * Final set is persisted to `wizardStore.host.variants` so
 * reload restores the grid (Decision #1).
 *
 * Contract — see useHostGeneration.ts header for the canonical doc.
 */

import { useCallback, useState } from 'react';
import { streamHost, type HostGenerateInput } from '../api/host';
import { humanizeError } from '../api/http';
import { imageIdFromPath } from '../api/mapping';
import { useWizardStore } from '../stores/wizardStore';
import { useAbortableRequest } from './useAbortableRequest';

export interface HostVariant {
  seed: number;
  id: string;
  /** Stable server-side identifier (filename stem, e.g. `host_abc12345_s10`). */
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
  /** Optional 5th tile — the previous batch's selected image, still
   * pickable until the next selection commits. */
  prevSelected: HostVariant | null;
  batchId: string | null;
  isLoading: boolean;
  error: string | null;
  /** Start a fresh stream. `seeds` overrides the backend default —
   * pass `makeRandomSeeds()` for "다시 만들기" that returns fresh
   * variants; omit to let the backend use its deterministic default
   * (so two users with the same input see the same output). */
  regenerate: (
    input: HostGenerateInput & { imageSize?: '1K' | '2K' | '4K' },
    seeds?: number[],
  ) => Promise<void>;
  abort: () => void;
}

export function useHostGeneration(): UseHostGenerationReturn {
  // Seed initial state from the store so a reload shows the last
  // run's grid instantly. We don't subscribe — store only matters
  // at mount; during an active stream we're authoritative.
  const initialHost = (useWizardStore.getState().host ?? {}) as Record<string, unknown>;
  const initialVariants = (initialHost.variants as HostVariant[] | undefined) ?? [];
  const initialPrev = (initialHost.prevSelected as HostVariant | null | undefined) ?? null;
  const initialBatchId = (initialHost.batchId as string | null | undefined) ?? null;

  const [variants, setVariants] = useState<HostVariant[]>(initialVariants);
  const [prevSelected, setPrevSelected] = useState<HostVariant | null>(initialPrev);
  const [batchId, setBatchId] = useState<string | null>(initialBatchId);
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
      // Placeholders are NOT drawn yet — wait for `init` to confirm
      // the backend accepted the request.
      setVariants([]);

      // Eager-persist prev_selected before the stream opens so a
      // mid-stream navigation preserves the prev tile. Backend's
      // authoritative prev_selected on `done` overrides this if it differs.
      const storeHostBefore = (useWizardStore.getState().host ?? {}) as Record<string, unknown>;
      const oldSelectedPath = storeHostBefore.selectedPath as string | null | undefined;
      const oldSelectedUrl = storeHostBefore.imageUrl as string | null | undefined;
      const oldSelectedSeed = storeHostBefore.selectedSeed as number | null | undefined;
      const oldSelectedImageId =
        (storeHostBefore.selectedImageId as string | null | undefined) ??
        (oldSelectedPath ? imageIdFromPath(oldSelectedPath) : undefined);
      const seedPrev: HostVariant | null =
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
      // Persist immediately so navigation away preserves prev info.
      useWizardStore.getState().setHost({
        variants: [],
        prevSelected: seedPrev,
        batchId: null,
      });

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
            // Persist arrived slots only — strip placeholders so a
            // remount won't render dead spinners.
            useWizardStore.getState().setHost({
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
            useWizardStore.getState().setHost({
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
