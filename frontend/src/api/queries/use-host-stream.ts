/**
 * useHostStream — TQ-bridged SSE consumer for /api/host/generate/stream.
 *
 * Lane F: streams Step 1 host candidates as a TanStack Query mutation
 * that writes each parsed event to the cache under
 * `['host-stream', requestId]`. Components subscribe via
 * `useHostStreamEvents(requestId)`. The `requestId` is a client-
 * generated UUID created BEFORE `mutate()` fires (the backend's
 * batch_id only arrives after the init event).
 *
 * Each event is parsed via `HostStreamEventSchema` (wire-shape +
 * .transform() to camelCase). Malformed events surface as a fatal
 * stream error rather than silent undefined deep in a render. The
 * existing `useHostGeneration` hook (with its inline state machine)
 * stays — this is a parallel, lower-level surface for Lane G's
 * mode-switching / sse-fatal-error E2E specs and any UI that wants
 * to read raw events.
 */

import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { streamHost, type HostGenerateInput } from '../host';
import { streamComposite, type CompositeInput } from '../composite';
import {
  parseHostStreamEvent,
  type HostStreamEvent,
} from '../sse-schemas';

interface HostStreamArgs {
  input: HostGenerateInput;
  requestId: string;
  signal?: AbortSignal;
}

interface CompositeStreamArgs {
  input: CompositeInput;
  requestId: string;
  signal?: AbortSignal;
}

/** Internal: dispatcher for both flavours. The wire shape is the
 * same; only the underlying async iterator differs. */
async function consumeStream(
  iter: AsyncGenerator<unknown>,
  qc: ReturnType<typeof useQueryClient>,
  key: ['host-stream' | 'composite-stream', string],
): Promise<HostStreamEvent[]> {
  const events: HostStreamEvent[] = [];
  for await (const wireEvt of iter) {
    const parsed = parseHostStreamEvent(wireEvt);
    events.push(parsed);
    qc.setQueryData<HostStreamEvent[]>(key, (prev) =>
      prev ? [...prev, parsed] : [parsed],
    );
    if (parsed.type === 'fatal') {
      // Throw so TQ marks the mutation as failed. Consumers reading
      // the cache see the fatal event in-line; the mutation surface
      // gives them the same error in `.error`.
      const err = new Error(parsed.error);
      (err as { status?: number | null }).status = parsed.status ?? null;
      throw err;
    }
  }
  return events;
}

export function useHostStream(): UseMutationResult<HostStreamEvent[], Error, HostStreamArgs> {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['host-stream'],
    // Generation POSTs MUST NOT auto-retry (would create duplicate
    // jobs). The global default is retry: 0 already, but make it
    // explicit at the callsite so future global tweaks don't bite.
    retry: 0,
    mutationFn: async ({ input, requestId, signal }: HostStreamArgs) => {
      qc.setQueryData<HostStreamEvent[]>(['host-stream', requestId], () => []);
      return consumeStream(
        streamHost(input, { signal }),
        qc,
        ['host-stream', requestId],
      );
    },
  });
}

export function useCompositeStream(): UseMutationResult<HostStreamEvent[], Error, CompositeStreamArgs> {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['composite-stream'],
    retry: 0,
    mutationFn: async ({ input, requestId, signal }: CompositeStreamArgs) => {
      qc.setQueryData<HostStreamEvent[]>(['composite-stream', requestId], () => []);
      return consumeStream(
        streamComposite(input, { signal }),
        qc,
        ['composite-stream', requestId],
      );
    },
  });
}

/** Subscribe to the events for a given requestId. The mutation
 * writes; this read-only query just reflects the cache. `enabled:
 * false` means we never trigger a fetch — the data only appears
 * when the mutation puts it there. The queryFn rejects so TQ never
 * silently substitutes a fallback if a future global default kicks in. */
async function neverFetched(): Promise<never> {
  throw new Error('event-stream subscriber: never fetched');
}

export function useHostStreamEvents(
  requestId: string | null,
): UseQueryResult<HostStreamEvent[], Error> {
  return useQuery<HostStreamEvent[]>({
    queryKey: ['host-stream', requestId ?? '__none__'],
    queryFn: neverFetched,
    enabled: false,
  });
}

export function useCompositeStreamEvents(
  requestId: string | null,
): UseQueryResult<HostStreamEvent[], Error> {
  return useQuery<HostStreamEvent[]>({
    queryKey: ['composite-stream', requestId ?? '__none__'],
    queryFn: neverFetched,
    enabled: false,
  });
}
