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

import { HostSchema, type Host } from './schema';

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
