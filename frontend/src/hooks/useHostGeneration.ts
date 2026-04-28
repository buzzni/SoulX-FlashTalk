/**
 * useHostGeneration — server-side job orchestrator (streaming-resume v9).
 *
 * Replaces the v8 SSE-driving hook. The new flow:
 *   1. regenerate(input) calls POST /api/jobs (kind='host'), receives a
 *      jobId, writes host.generation = attached(jobId) to the wizard
 *      store.
 *   2. The store change triggers useJobSnapshot subscription via the
 *      Step1Host page; this hook reads that snapshot from jobCacheStore.
 *   3. UI variants are derived from the cache's variants array.
 *      Reload, cross-device, and resume are all free — the server is
 *      authoritative.
 *
 * Kept the public surface (variants, prevSelected, batchId, isLoading,
 * error, regenerate, abort) so Step1Host doesn't need a major rewrite.
 * `abort` now cancels via DELETE /api/jobs/:id rather than aborting an
 * SSE fetch.
 */

import { useCallback, useState } from 'react';
import { humanizeError } from '../api/http';
import { imageIdFromPath } from '../api/mapping';
import { createJob, deleteJob, type HostJobInput } from '../api/jobs';
import {
  selectJobEntry,
  useJobCacheStore,
} from '../stores/jobCacheStore';
import { useWizardStore } from '../stores/wizardStore';
import { useJobSnapshot } from './useJobSnapshot';

/** UI/transient host variant. Lifted from the cache's JobVariant. */
export interface HostVariant {
  seed: number;
  id: string;
  imageId?: string | null;
  url?: string;
  path?: string;
  placeholder: boolean;
  error?: string;
  isPrev?: boolean;
}

export interface UseHostGenerationReturn {
  variants: HostVariant[];
  prevSelected: HostVariant | null;
  batchId: string | null;
  isLoading: boolean;
  error: string | null;
  regenerate: (
    input: HostJobInput,
    seeds?: number[],
  ) => Promise<void>;
  abort: () => void;
}

export interface HostGenerateUIInput {
  mode?: string;
  text_prompt?: string | null;
  face_ref_path?: string | null;
  outfit_ref_path?: string | null;
  style_ref_path?: string | null;
  extra_prompt?: string | null;
  builder?: Record<string, unknown> | null;
  negative_prompt?: string | null;
  face_strength?: number;
  outfit_strength?: number;
  outfit_text?: string | null;
  imageSize?: string;
  n?: number;
  temperature?: number | null;
}

/** Translate the legacy snake_case UI-side input into the JSON body
 * /api/jobs (kind='host') expects. The Form-style POST endpoint has
 * been deprecated; this is the canonical mapping going forward. */
function toHostJobInput(
  input: HostGenerateUIInput,
  seeds?: number[],
): HostJobInput {
  return {
    mode: input.mode ?? 'text',
    prompt: input.text_prompt ?? null,
    extraPrompt: input.extra_prompt ?? null,
    negativePrompt: input.negative_prompt ?? null,
    builder: input.builder ?? null,
    faceRefPath: input.face_ref_path ?? null,
    outfitRefPath: input.outfit_ref_path ?? null,
    styleRefPath: input.style_ref_path ?? null,
    faceStrength: input.face_strength ?? 0.7,
    outfitStrength: input.outfit_strength ?? 0.7,
    outfitText: input.outfit_text ?? null,
    seeds: seeds ?? null,
    imageSize: input.imageSize ?? '1K',
    n: input.n ?? 4,
    temperature: input.temperature ?? null,
  };
}

export function useHostGeneration(): UseHostGenerationReturn {
  const setHost = useWizardStore((s) => s.setHost);
  const generation = useWizardStore((s) => s.host.generation);
  const selected = useWizardStore((s) => s.host.selected);
  const jobId =
    generation.state === 'attached' ? generation.jobId : null;
  // useJobSnapshot subscribes (refcounted) and returns the live entry.
  const entry = useJobSnapshot(jobId);
  const [error, setError] = useState<string | null>(null);

  const regenerate = useCallback(
    async (input: HostJobInput | HostGenerateUIInput, seeds?: number[]): Promise<void> => {
      setError(null);
      try {
        const body: HostJobInput =
          'text_prompt' in input || 'face_ref_path' in input
            ? toHostJobInput(input as HostGenerateUIInput, seeds)
            : { ...(input as HostJobInput), seeds: seeds ?? (input as HostJobInput).seeds };
        const job = await createJob({ kind: 'host', input: body });
        // step 18 (UI gate fix): keep host.selected as-is during the
        // re-roll. The deriveReturn path uses it as a fallback prev
        // tile until the snapshot's prev_selected_image_id lands on
        // 'done', so the user never sees an empty 5th tile during
        // streaming. handleSelectVariant overwrites selected when the
        // user picks from the new batch.
        setHost((prev) => ({
          ...prev,
          generation: { state: 'attached', jobId: job.id },
        }));
      } catch (e) {
        setError(humanizeError(e));
      }
    },
    [setHost],
  );

  const abort = useCallback(() => {
    if (!jobId) return;
    deleteJob(jobId).catch((e) => {
      // Already terminal (409) or already gone (404) — silent. Other
      // errors surface so the user knows the cancel didn't land.
      const status = (e as { status?: number } | null)?.status;
      if (status === 409 || status === 404) return;
      setError(humanizeError(e));
    });
  }, [jobId]);

  return deriveReturn(entry, selected, error, regenerate, abort);
}

/** Project the cache entry onto the v8-shaped return. The public
 * surface (variants, prevSelected, batchId, isLoading, error,
 * regenerate, abort) stays stable so Step1Host doesn't churn.
 *
 * step 18 prev-tile gate: if the snapshot doesn't yet carry a
 * prev_selected_image_id (server publishes it on 'done'), fall back
 * to host.selected — the user's pre-regenerate pick. Once the new
 * batch's variants render, handleSelectVariant overwrites
 * host.selected; once 'done' lands, snap.prev_selected_image_id wins.
 * Net: the 5th tile never blanks mid-stream. */
function deriveReturn(
  entry: ReturnType<ReturnType<typeof selectJobEntry>>,
  schemaSelected: { imageId: string; path: string; url: string; seed: number } | null,
  error: string | null,
  regenerate: UseHostGenerationReturn['regenerate'],
  abort: UseHostGenerationReturn['abort'],
): UseHostGenerationReturn {
  // suppress unused-import warning — useJobCacheStore re-export is
  // for tests only; functional reference here keeps the linter happy.
  void useJobCacheStore;

  const snap = entry.snapshot;
  if (!snap) {
    return {
      variants: [],
      prevSelected: null,
      batchId: null,
      isLoading: entry.isLoading,
      error: error ?? entry.error,
      regenerate,
      abort,
    };
  }

  const variants: HostVariant[] = snap.variants.map((v, i) => ({
    seed: typeof v.seed === 'number' ? v.seed : i,
    id: typeof v.image_id === 'string' ? v.image_id : `v${i}`,
    imageId: typeof v.image_id === 'string'
      ? v.image_id
      : (typeof v.path === 'string' ? imageIdFromPath(v.path) : null),
    url: typeof v.url === 'string' ? v.url : undefined,
    path: typeof v.path === 'string' ? v.path : undefined,
    placeholder: false,
  }));

  // Server-provided prev wins; otherwise fall back to the user's
  // pre-regenerate pick so streaming never shows an empty 5th tile.
  // Suppress the fallback if schemaSelected.imageId already appears
  // in the new variants — it's the user's current-batch pick, not a
  // "previous" item.
  const newBatchHasSchemaSelected = schemaSelected
    ? variants.some((v) => v.imageId === schemaSelected.imageId)
    : false;
  const prevSelected: HostVariant | null = snap.prev_selected_image_id
    ? {
        seed: -1,
        id: `prev-${snap.prev_selected_image_id}`,
        imageId: snap.prev_selected_image_id,
        placeholder: false,
        isPrev: true,
      }
    : (schemaSelected && !newBatchHasSchemaSelected
        ? {
            seed: schemaSelected.seed,
            id: `prev-${schemaSelected.imageId}`,
            imageId: schemaSelected.imageId,
            url: schemaSelected.url,
            path: schemaSelected.path,
            placeholder: false,
            isPrev: true,
          }
        : null);

  const isLoading =
    entry.isLoading ||
    snap.state === 'pending' ||
    snap.state === 'streaming';

  return {
    variants,
    prevSelected,
    batchId: snap.batch_id,
    isLoading,
    error: error ?? entry.error ?? snap.error,
    regenerate,
    abort,
  };
}
