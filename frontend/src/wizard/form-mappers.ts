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
  ProductsSchema,
  type Host,
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
