/**
 * Wizard form mappers — bidirectional bridge between the persistent
 * zustand slices (full domain shape) and the form-controllable subset
 * each step page edits via react-hook-form.
 *
 * The store carries fields the user can never directly edit (generation
 * lifecycle, selected variant, batchId). The form only owns what the
 * user types or picks. The mappers project between the two without
 * losing the non-form fields on a write back.
 *
 * Shape rules:
 *   - `*ToFormValues` strips every non-form field from the slice.
 *   - `formValuesTo*` takes the form values + the previous slice and
 *     re-attaches the non-form fields. The previous slice is the source
 *     of truth for everything not in the form.
 */

import {
  BackgroundSchema,
  CompositionSettingsSchema,
  HostSchema,
  LocalAssetSchema,
  ProductsSchema,
  ScriptSchema,
  ServerAssetSchema,
  VoiceAdvancedSchema,
  VoiceCloneSampleSchema,
  type Host,
  type Voice,
  type VoiceGeneration,
} from './schema';
import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────
// Step 1 — Host
// ────────────────────────────────────────────────────────────────────

/**
 * Form-controllable subset of the Host slice. Excludes `generation`
 * (state machine driven by the streaming hook + variant-pick handler).
 *
 * The `input` discriminated union lives in the form as-is. RHF accepts
 * arbitrary values, so the LocalAsset.file (File handle) can sit in
 * form state during a session — only persistence layers strip it.
 */
export const HostFormValuesSchema = HostSchema.omit({ generation: true });
export type HostFormValues = Omit<Host, 'generation'>;

export function hostSliceToFormValues(host: Host): HostFormValues {
  const { generation: _generation, ...rest } = host;
  return rest;
}

export function formValuesToHostSlice(values: HostFormValues, prev: Host): Host {
  return {
    ...prev,
    input: values.input,
    temperature: values.temperature,
  };
}

// ────────────────────────────────────────────────────────────────────
// Step 2 — Products + Background + Composition.settings
// ────────────────────────────────────────────────────────────────────

/**
 * Step 2's form spans three store slices: `products`, `background`,
 * and `composition.settings`. `composition.generation` is the
 * composite-stream lifecycle (state machine, batchId, variants,
 * selected) and stays in the store — it's never user-edited and
 * MUST NOT enter the form, otherwise streaming candidate events
 * trigger spurious form resets that wipe in-progress edits.
 *
 * `imageQuality`, `resolution`, and `playlistId` are top-level wizard
 * state owned by other steps; they don't appear here either.
 *
 * The container inlines the projection (`{products, background,
 * settings: composition.settings}`) so it can memoize on the narrow
 * deps; we don't ship a `step2SliceToFormValues` helper because the
 * indirection would re-introduce the temptation to depend on the
 * full `composition` object.
 */
export const Step2FormValuesSchema = z.object({
  products: ProductsSchema,
  background: BackgroundSchema,
  settings: CompositionSettingsSchema,
});
export type Step2FormValues = z.infer<typeof Step2FormValuesSchema>;

// ────────────────────────────────────────────────────────────────────
// Step 3 — Voice (excluding generation lifecycle)
// ────────────────────────────────────────────────────────────────────

/**
 * Form-controllable subset of the Voice slice. Each variant of the
 * tagged union drops `generation` (TTS state machine driven by
 * useTTSGeneration). `voice.sample` (clone-mode upload state machine)
 * STAYS in the form because user edits drive `empty → pending`; the
 * `pending → cloned` transition is hook-driven (useVoiceClone) but
 * still reflected in form state via store→form sync.
 *
 * `voice.audio` for upload mode also stays in the form: the user picks
 * a LocalAsset, eager upload swaps it to ServerAsset (Step 2 pattern).
 *
 * `resolution`, `playlistId`, `imageQuality` are top-level wizard
 * state owned by other concerns; not in the Step 3 form.
 *
 * As with Step 2, the container subscribes to NARROW voice fields
 * (source / script / advanced / voiceId / voiceName / sample / audio)
 * and excludes `voice.generation` from form values, so SSE/TTS
 * lifecycle mutations don't trigger a form.reset that would wipe
 * in-progress edits.
 */
export const VoiceFormValuesSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('tts'),
    voiceId: z.string().nullable(),
    voiceName: z.string().nullable(),
    advanced: VoiceAdvancedSchema,
    script: ScriptSchema,
  }),
  z.object({
    source: z.literal('clone'),
    sample: VoiceCloneSampleSchema,
    pendingName: z.string(),
    advanced: VoiceAdvancedSchema,
    script: ScriptSchema,
  }),
  z.object({
    source: z.literal('upload'),
    audio: z.union([ServerAssetSchema, LocalAssetSchema, z.null()]),
    script: ScriptSchema,
  }),
]);
export type VoiceFormValues = z.infer<typeof VoiceFormValuesSchema>;

export const Step3FormValuesSchema = z.object({
  voice: VoiceFormValuesSchema,
});
export type Step3FormValues = z.infer<typeof Step3FormValuesSchema>;

export function voiceSliceToFormValues(voice: Voice): VoiceFormValues {
  if (voice.source === 'upload') {
    return { source: 'upload', audio: voice.audio, script: voice.script };
  }
  if (voice.source === 'clone') {
    return {
      source: 'clone',
      sample: voice.sample,
      pendingName: voice.pendingName,
      advanced: voice.advanced,
      script: voice.script,
    };
  }
  return {
    source: 'tts',
    voiceId: voice.voiceId,
    voiceName: voice.voiceName,
    advanced: voice.advanced,
    script: voice.script,
  };
}

/**
 * Re-attach `generation` from the previous slice when committing form
 * values back to the store. tts ↔ clone share the same TTS generation
 * pipeline (same `useTTSGeneration` hook, same `voice.generation`
 * shape, same audio path). Swapping between those two sub-modes must
 * preserve a `ready` audio result so the user doesn't lose the audio
 * they just generated. Only ai ↔ upload is a real pipeline change
 * that justifies resetting to `idle`. Upload variant has no
 * generation field.
 */
export function formValuesToVoiceSlice(values: VoiceFormValues, prev: Voice): Voice {
  if (values.source === 'upload') {
    return { source: 'upload', audio: values.audio, script: values.script };
  }
  const prevGen: VoiceGeneration =
    // Both prev and values are ai-side (tts or clone) — carry the
    // generation. This includes tts↔clone swaps. ai↔upload still
    // resets because the upload branch has no generation field at all.
    prev.source !== 'upload'
      ? prev.generation
      : { state: 'idle' };
  if (values.source === 'tts') {
    return {
      source: 'tts',
      voiceId: values.voiceId,
      voiceName: values.voiceName,
      advanced: values.advanced,
      script: values.script,
      generation: prevGen,
    };
  }
  return {
    source: 'clone',
    sample: values.sample,
    pendingName: values.pendingName,
    advanced: values.advanced,
    script: values.script,
    generation: prevGen,
  };
}
