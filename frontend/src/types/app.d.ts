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

// ────────────────────────────────────────────────────────────────────
// Wizard state (UI-owned; never sent to server)
// ────────────────────────────────────────────────────────────────────

export type WizardStep = 1 | 2 | 3;

export interface WizardHost {
  mode?: 'text' | 'image' | null;
  textPrompt?: string;
  referenceImagePath?: string | null;
  referenceImageUrl?: string | null;
  faceRefPath?: string | null;
  outfitRefPath?: string | null;
  outfitText?: string;
  temperature?: number;
  imageSize?: '1K' | '2K' | '4K';
  variants?: HostVariant[];
  selectedSeed?: number | null;
  imageUrl?: string | null;
}

export interface HostVariant {
  seed: number;
  imageUrl: string;
  imagePath?: string;
}

export interface WizardProduct {
  id: string;
  name?: string;
  path?: string | null;
  url?: string | null;
  /** Transient — present only while a File is staged for upload. Dropped
   * by `partialize` before localStorage persist so `persist` doesn't try
   * to serialise a File object (which it can't). */
  _file?: File;
}

export interface WizardBackground {
  source?: 'preset' | 'prompt' | 'upload' | 'url' | null;
  preset?: { id: string; label: string } | null;
  presetId?: string;
  presetLabel?: string;
  prompt?: string;
  uploadPath?: string | null;
  uploadUrl?: string | null;
}

export interface WizardComposition {
  shot?: 'closeup' | 'bust' | 'medium' | 'full';
  temperature?: number;
  variants?: CompositionVariant[];
  selectedUrl?: string | null;
  selectedPath?: string | null;
}

export interface CompositionVariant {
  seed: number;
  url: string;
  path?: string;
}

export interface WizardVoice {
  source?: 'tts' | 'clone' | 'upload' | null;
  voiceId?: string | null;
  voiceName?: string | null;
  script?: string;
  audioUrl?: string | null;
  audioPath?: string | null;
}

/** Resolution preset — the full object shape the wizard carries and the
 * backend ultimately consumes via `stringifyResolution({width, height})`.
 * Stored verbatim in localStorage so Step 3's picker round-trips unchanged. */
export interface ResolutionPreset {
  key: string;           // '448p' | '720p' | '1080p' — UI preset id
  label: string;
  width: number;
  height: number;
  size?: string;         // human-readable file-size estimate (e.g. '~28MB')
  speed?: string;        // human-readable speed hint (e.g. '빠름')
  default?: boolean;
}

