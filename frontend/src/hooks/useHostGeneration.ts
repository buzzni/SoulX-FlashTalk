/**
 * useHostGeneration — SSE-driven host candidate generation.
 *
 * Phase 3 per REFACTOR_PLAN.md. Wraps `api.host.streamHost`, applies
 * the concurrency contract from `useAbortableRequest`, and writes
 * final variants back to `wizardStore.host.variants` so they survive
 * reload (per Decision #1: variants persist, not transient).
 *
 * Contract:
 *   const { variants, isLoading, error, regenerate, abort } =
 *     useHostGeneration();
 *
 *   - `variants` — live array; updates as each SSE `candidate` event
 *     arrives. Initial value comes from `wizardStore.host.variants`,
 *     so if the user has finished a run and reloaded, the grid
 *     appears immediately.
 *   - `isLoading` — true while a stream is in flight.
 *   - `error` — humanized error string, or null.
 *   - `regenerate(seeds?)` — start a new stream. If another stream
 *     is in flight, it's aborted. `seeds` is optional: omit to let
 *     the backend pick its default set; pass `makeRandomSeeds()`
 *     for "다시 만들기" that returns fresh variants.
 *   - `abort()` — cancel the current stream without starting a new
 *     one (cancel-button UX).
 *
 * Stale-result protection: late SSE frames from an aborted stream
 * are filtered via `isCurrent()` before touching state. Without
 * this, rapid re-clicks of "다시 만들기" could interleave events
 * from multiple streams.
 */

import { useCallback, useState } from 'react';
import { streamHost, type HostGenerateInput, type StreamEvent } from '../api/host';
import { humanizeError } from '../api/http';
import { useWizardStore } from '../stores/wizardStore';
import { useAbortableRequest } from './useAbortableRequest';

export interface UseHostGenerationReturn {
  variants: StreamEvent[];
  isLoading: boolean;
  error: string | null;
  regenerate: (seeds?: number[]) => Promise<void>;
  abort: () => void;
}

export function useHostGeneration(): UseHostGenerationReturn {
  // Seed initial state from the store so a reload shows the last run's
  // variants instantly. We don't subscribe — the store only matters at
  // mount time; during an active stream we're authoritative.
  const initialVariants =
    (useWizardStore.getState().host?.variants as StreamEvent[] | undefined) ?? [];

  const [variants, setVariants] = useState<StreamEvent[]>(initialVariants);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { run, abort } = useAbortableRequest();

  const regenerate = useCallback(
    async (seeds?: number[]) => {
      const { signal, isCurrent } = run();
      // Read host slice at call time — do NOT subscribe (would
      // re-create the callback on every keystroke).
      const host = useWizardStore.getState().host as HostGenerateInput;
      const input: HostGenerateInput = seeds ? { ...host, _seeds: seeds } : host;

      setIsLoading(true);
      setError(null);
      const collected: StreamEvent[] = [];
      setVariants(collected);

      try {
        for await (const evt of streamHost(input, { signal })) {
          if (!isCurrent()) return; // a newer run started; drop this frame

          // Stream shape is "candidate" per completed variant plus
          // terminal "done"/"error" frames. Anything else is a progress
          // heartbeat the caller may or may not care about — we
          // accumulate everything and let Phase 4 UIs filter.
          if (evt.type === 'candidate' || evt.type === 'placeholder') {
            collected.push(evt);
            setVariants([...collected]);
          } else if (evt.type === 'done') {
            break;
          } else if (evt.type === 'fatal' || evt.type === 'error') {
            if (typeof evt.error === 'string') {
              throw new Error(evt.error);
            }
          }
        }

        if (!isCurrent()) return;

        setIsLoading(false);
        // Persist the finished set to the store so a reload shows the
        // grid (and Step 2 picks up the selected host for composition).
        useWizardStore.getState().setHost({ variants: collected });
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
