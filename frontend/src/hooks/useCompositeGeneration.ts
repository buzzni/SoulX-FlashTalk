/**
 * useCompositeGeneration — SSE-driven composite (host × products ×
 * background) candidate generation.
 *
 * Twin of `useHostGeneration` — same contract, same concurrency
 * guards, just a different backend endpoint. Final variants land in
 * `wizardStore.composition.variants` (persistent — Decision #1).
 *
 * See useHostGeneration.ts for contract docs.
 */

import { useCallback, useState } from 'react';
import { streamComposite, type CompositeInput } from '../api/composite';
import type { StreamEvent } from '../api/host';
import { humanizeError } from '../api/http';
import { useWizardStore } from '../stores/wizardStore';
import { useAbortableRequest } from './useAbortableRequest';

export interface UseCompositeGenerationOptions {
  /** Backend runs rembg background removal by default; pass `false`
   * to skip (faster, lower quality). */
  rembg?: boolean;
}

export interface UseCompositeGenerationReturn {
  variants: StreamEvent[];
  isLoading: boolean;
  error: string | null;
  regenerate: (seeds?: number[], opts?: UseCompositeGenerationOptions) => Promise<void>;
  abort: () => void;
}

export function useCompositeGeneration(): UseCompositeGenerationReturn {
  const initialVariants =
    (useWizardStore.getState().composition?.variants as StreamEvent[] | undefined) ?? [];

  const [variants, setVariants] = useState<StreamEvent[]>(initialVariants);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { run, abort } = useAbortableRequest();

  const regenerate = useCallback(
    async (seeds?: number[], opts: UseCompositeGenerationOptions = {}) => {
      const { signal, isCurrent } = run();
      const s = useWizardStore.getState();
      const input = {
        host: { selectedPath: (s.host?.selectedPath as string | undefined) ?? null },
        products: (s.products ?? []) as CompositeInput['products'],
        background: (s.background ?? {}) as CompositeInput['background'],
        composition: seeds
          ? { ...(s.composition ?? {}), _seeds: seeds }
          : (s.composition ?? {}),
      };

      setIsLoading(true);
      setError(null);
      const collected: StreamEvent[] = [];
      setVariants(collected);

      try {
        for await (const evt of streamComposite(input, { signal, rembg: opts.rembg ?? true })) {
          if (!isCurrent()) return;
          if (evt.type === 'candidate' || evt.type === 'placeholder') {
            collected.push(evt);
            setVariants([...collected]);
          } else if (evt.type === 'done') {
            break;
          } else if (evt.type === 'fatal' || evt.type === 'error') {
            if (typeof evt.error === 'string') throw new Error(evt.error);
          }
        }

        if (!isCurrent()) return;
        setIsLoading(false);
        useWizardStore.getState().setComposition({ variants: collected });
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

  return { variants, isLoading, error, regenerate, abort };
}
