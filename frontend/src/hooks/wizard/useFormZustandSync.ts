/**
 * useFormZustandSync — bridge a zustand slice → react-hook-form.
 *
 * RHF defaults aren't reactive: once the form mounts with
 * `defaultValues: hostSliceToFormValues(host)`, an external slice
 * update (variant pick, generation result, upload completion) won't
 * propagate. This hook subscribes to a slice and calls `form.reset()`
 * whenever the slice changes shape, so the form mirrors the store
 * even when something other than the user is the editor.
 *
 * Pair with `useDebouncedFormSync` for the form → store direction.
 *
 * Usage:
 *   const host = useHost();
 *   const form = useForm({ defaultValues: hostSliceToFormValues(host) });
 *   useFormZustandSync(form, host, hostSliceToFormValues);
 *
 * The `mapper` is the slice → form-values projection (typically the
 * same one used for `defaultValues`). Reference equality on the slice
 * triggers a `reset` — keep mapper pure.
 */

import { useEffect, useRef } from 'react';
import type { UseFormReturn, FieldValues } from 'react-hook-form';

export function useFormZustandSync<S, V extends FieldValues>(
  form: UseFormReturn<V>,
  slice: S,
  mapper: (slice: S) => V,
): void {
  // Track the last-seen slice by reference — `form.reset` blows away
  // dirty user input, so we only fire when the slice actually changes.
  const lastSliceRef = useRef<S>(slice);

  useEffect(() => {
    if (lastSliceRef.current === slice) return;
    lastSliceRef.current = slice;
    // Hard reset (no keepDirtyValues): tagged-union slices like
    // HostInput swap their entire shape on mode change, and
    // keepDirtyValues would preserve a dirty discriminator field on
    // the OLD shape, leaving the form schema-invalid until the next
    // user input. Spurious resets from debounce round-trips are
    // suppressed in `useDebouncedFormSync` instead, where same-value
    // flushes never reach `setHost` in the first place.
    form.reset(mapper(slice), {
      keepDirty: false,
      keepErrors: false,
      keepTouched: false,
      keepIsSubmitted: false,
    });
  }, [slice, form, mapper]);
}
