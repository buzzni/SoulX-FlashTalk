/**
 * SSE event schemas — hand-written because OpenAPI does not model
 * streaming responses. Each schema mirrors the **wire shape** (the
 * exact JSON the backend emits, snake_case) and `.transform()`s it to
 * the camelCase shape consumers expect.
 *
 * Why wire-shape-first: with a single source of truth at parse time,
 * field renames on the backend manifest as parse failures with full
 * context, not silent `undefined` propagation deep inside a render.
 *
 * Wire format reference (`modules/host_generator.py` /
 * `modules/composite_generator.py` SSE writers):
 *
 *   init     → { type, seeds: int[]?, batch_id: str?, prev_selected: {...}? }
 *   candidate→ { type, seed: int, path: str, url: str, batch_id: str? }
 *   error    → { type, seed: int, error: str }
 *   fatal    → { type, error: str, status: int? }
 *   done     → { type, total: int?, min_success_met: bool?,
 *                batch_id: str?, prev_selected: {...}? }
 *
 *   prev_selected = {
 *     image_id: str, url: str, path: str, seed: int,
 *   }
 *
 * Lane F (RHF + SSE bridge) wires these into a TanStack Query mutation
 * that calls `setQueryData(['host-stream', requestId])` per event.
 * Lane B just lands the schemas + a tiny dispatcher so consumers can
 * adopt them incrementally.
 */

import { z } from 'zod';
import { imageIdFromPath } from './mapping';

// ────────────────────────────────────────────────────────────────────
// Shared sub-shapes
// ────────────────────────────────────────────────────────────────────

const PrevSelectedWireSchema = z.object({
  image_id: z.string(),
  url: z.string(),
  path: z.string(),
  seed: z.number(),
});

const PrevSelectedSchema = PrevSelectedWireSchema.transform((raw) => ({
  imageId: raw.image_id,
  url: raw.url,
  path: raw.path,
  seed: raw.seed,
}));
export type PrevSelectedEvent = z.output<typeof PrevSelectedSchema>;

// ────────────────────────────────────────────────────────────────────
// Host stream — discriminated on `type`
// ────────────────────────────────────────────────────────────────────

const InitEventWireSchema = z.object({
  type: z.literal('init'),
  seeds: z.array(z.number()).optional(),
  batch_id: z.string().optional(),
  prev_selected: PrevSelectedWireSchema.optional(),
});

const CandidateEventWireSchema = z.object({
  type: z.literal('candidate'),
  seed: z.number(),
  path: z.string(),
  url: z.string(),
  batch_id: z.string().optional(),
});

const ErrorEventWireSchema = z.object({
  type: z.literal('error'),
  seed: z.number(),
  error: z.string(),
});

const FatalEventWireSchema = z.object({
  type: z.literal('fatal'),
  error: z.string(),
  status: z.number().optional(),
});

const DoneEventWireSchema = z.object({
  type: z.literal('done'),
  total: z.number().optional(),
  min_success_met: z.boolean().optional(),
  batch_id: z.string().optional(),
  prev_selected: PrevSelectedWireSchema.optional(),
});

const HostStreamWireSchema = z.discriminatedUnion('type', [
  InitEventWireSchema,
  CandidateEventWireSchema,
  ErrorEventWireSchema,
  FatalEventWireSchema,
  DoneEventWireSchema,
]);

export const HostStreamEventSchema = HostStreamWireSchema.transform((wire) => {
  switch (wire.type) {
    case 'init':
      return {
        type: 'init' as const,
        seeds: wire.seeds ?? null,
        batchId: wire.batch_id ?? null,
        prevSelected: wire.prev_selected
          ? PrevSelectedSchema.parse(wire.prev_selected)
          : null,
      };
    case 'candidate':
      return {
        type: 'candidate' as const,
        seed: wire.seed,
        path: wire.path,
        url: wire.url,
        batchId: wire.batch_id ?? null,
        imageId: imageIdFromPath(wire.path) ?? '',
      };
    case 'error':
      return {
        type: 'error' as const,
        seed: wire.seed,
        error: wire.error,
      };
    case 'fatal':
      return {
        type: 'fatal' as const,
        error: wire.error,
        status: wire.status ?? null,
      };
    case 'done':
      return {
        type: 'done' as const,
        total: wire.total ?? null,
        minSuccessMet: wire.min_success_met ?? null,
        batchId: wire.batch_id ?? null,
        prevSelected: wire.prev_selected
          ? PrevSelectedSchema.parse(wire.prev_selected)
          : null,
      };
  }
});
export type HostStreamEvent = z.output<typeof HostStreamEventSchema>;

// ────────────────────────────────────────────────────────────────────
// Composite stream — same envelope as host today.
// ────────────────────────────────────────────────────────────────────

export const CompositeStreamEventSchema = HostStreamEventSchema;
export type CompositeStreamEvent = HostStreamEvent;

// ────────────────────────────────────────────────────────────────────
// Helper — `safeParse` wrapper that surfaces a structured fatal event
// instead of throwing, so consumers can render an inline error without
// a try/catch around their for-await loop.
// ────────────────────────────────────────────────────────────────────

export function parseHostStreamEvent(
  raw: unknown,
): HostStreamEvent | { type: 'fatal'; error: string; status: null } {
  const result = HostStreamEventSchema.safeParse(raw);
  if (result.success) return result.data;
  return {
    type: 'fatal',
    error: `이벤트 파싱 실패: ${result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')}`,
    status: null,
  };
}
