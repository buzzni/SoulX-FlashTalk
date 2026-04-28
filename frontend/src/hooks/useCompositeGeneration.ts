/**
 * useCompositeGeneration — server-side job orchestrator (v9 mirror of
 * useHostGeneration). See that file's header for the new flow; this
 * one is identical except the kind is 'composite' and the input shape
 * maps composition-specific fields.
 */

import { useCallback, useState } from 'react';
import { humanizeError } from '../api/http';
import { imageIdFromPath } from '../api/mapping';
import {
  createJob,
  deleteJob,
  type CompositeJobInput,
} from '../api/jobs';
import {
  selectJobEntry,
  useJobCacheStore,
} from '../stores/jobCacheStore';
import { useWizardStore } from '../stores/wizardStore';
import { useJobSnapshot } from './useJobSnapshot';

export interface CompositionVariant {
  seed: number;
  id: string;
  imageId?: string | null;
  url?: string;
  path?: string;
  placeholder: boolean;
  error?: string;
  isPrev?: boolean;
}

export interface UseCompositeGenerationReturn {
  variants: CompositionVariant[];
  prevSelected: CompositionVariant | null;
  batchId: string | null;
  isLoading: boolean;
  error: string | null;
  regenerate: (
    input: CompositeJobInput,
    seeds?: number[],
    opts?: { rembg?: boolean },
  ) => Promise<void>;
  abort: () => void;
}

export function useCompositeGeneration(): UseCompositeGenerationReturn {
  const setComposition = useWizardStore((s) => s.setComposition);
  const generation = useWizardStore((s) => s.composition.generation);
  const jobId =
    generation.state === 'attached' ? generation.jobId : null;
  const entry = useJobSnapshot(jobId);
  const [error, setError] = useState<string | null>(null);

  const regenerate = useCallback(
    async (
      input: CompositeJobInput,
      seeds?: number[],
      opts: { rembg?: boolean } = {},
    ): Promise<void> => {
      setError(null);
      try {
        const body: CompositeJobInput = {
          ...input,
          seeds: seeds ?? input.seeds ?? null,
          rembg: opts.rembg ?? input.rembg ?? true,
        };
        const job = await createJob({ kind: 'composite', input: body });
        setComposition((prev) => ({
          ...prev,
          generation: { state: 'attached', jobId: job.id },
          selected: null,
        }));
      } catch (e) {
        setError(humanizeError(e));
      }
    },
    [setComposition],
  );

  const abort = useCallback(() => {
    if (!jobId) return;
    deleteJob(jobId).catch((e) => {
      const status = (e as { status?: number } | null)?.status;
      if (status === 409 || status === 404) return;
      setError(humanizeError(e));
    });
  }, [jobId]);

  return deriveReturn(entry, error, regenerate, abort);
}

function deriveReturn(
  entry: ReturnType<ReturnType<typeof selectJobEntry>>,
  error: string | null,
  regenerate: UseCompositeGenerationReturn['regenerate'],
  abort: UseCompositeGenerationReturn['abort'],
): UseCompositeGenerationReturn {
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

  const variants: CompositionVariant[] = snap.variants.map((v, i) => ({
    seed: typeof v.seed === 'number' ? v.seed : i,
    id: typeof v.image_id === 'string' ? v.image_id : `c${i}`,
    imageId: typeof v.image_id === 'string'
      ? v.image_id
      : (typeof v.path === 'string' ? imageIdFromPath(v.path) : null),
    url: typeof v.url === 'string' ? v.url : undefined,
    path: typeof v.path === 'string' ? v.path : undefined,
    placeholder: false,
  }));

  const prevSelected: CompositionVariant | null = snap.prev_selected_image_id
    ? {
        seed: -1,
        id: `prev-${snap.prev_selected_image_id}`,
        imageId: snap.prev_selected_image_id,
        placeholder: false,
        isPrev: true,
      }
    : null;

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
