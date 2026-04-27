/**
 * Hand-written UI-only types that compose the generated API types from
 * `src/types/generated/api.d.ts` (produced by `npm run gen:types` against
 * the backend's `/openapi.json`).
 *
 * Rule of thumb:
 * - **Server-sourced shapes** (queue rows, result manifests, task state,
 *   history items) are type aliases over `components['schemas'][…]` —
 *   never hand-duplicated. When the backend evolves, run `npm run gen:types`
 *   and any drift manifests as a TS error instead of a silent bug.
 * - **UI-only shapes** (wizard state, transient upload flags, UI selectors)
 *   stay local. The backend doesn't know or care about them.
 *
 * Per-component prop types stay alongside their components (once Phase 4
 * renames `.jsx → .tsx`). This file is the shared contract, not a grab
 * bag.
 */

import type { components } from './generated/api';

// ────────────────────────────────────────────────────────────────────
// Server-sourced types (re-exported from generated)
// ────────────────────────────────────────────────────────────────────

export type QueueEntry = components['schemas']['QueueEntry'];
export type QueueSnapshot = components['schemas']['QueueSnapshot'];
export type TaskStateSnapshot = components['schemas']['TaskStateSnapshot'];
export type ResultManifest = components['schemas']['ResultManifest'];
export type ResultParams = components['schemas']['ResultParams'];
export type VideoHistoryItem = components['schemas']['VideoHistoryItem'];
export type HistoryResponse = components['schemas']['HistoryResponse'];

// Task classification literals — generated via FastAPI enum-serialisation
// of the `Literal[…]` hints in modules/schemas.py.
export type TaskType = NonNullable<QueueEntry['type']>;
export type TaskStatus = NonNullable<QueueEntry['status']>;

/** Stage keys emitted by `update_task()` in the worker. Backend is a string
 * rather than a strict enum (new stages shouldn't block a frontend build);
 * if you add a UI branch for a new stage, update `resolveStageIdx` as well. */
export type TaskStage =
  | 'queued'
  | 'loading'
  | 'preparing'
  | 'compositing_bg'
  | 'generating'
  | 'saving'
  | 'compositing'
  | 'complete'
  | 'error'
  | (string & {}); // allows unknown stages without losing autocomplete on known ones

