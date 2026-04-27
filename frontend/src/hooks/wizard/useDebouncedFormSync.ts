/**
 * useDebouncedFormSync — RHF watch → zustand draft, debounced.
 *
 * D2 shape: every change debounces 300ms then fires `setSlice(values)`.
 * Preserves the wizard's existing "every change persists" UX while
 * keeping the typing path off zustand's render frequency.
 *
 * Pair with `useFormZustandSync` for the store → form direction so
 * external updates (generation result, upload completion) reach the
 * form even when the user isn't typing.
 *
 * Usage:
 *   useDebouncedFormSync(form, (values) => setHost(formToHost(values)), 300);
 */

import { useEffect, useMemo, useRef } from 'react';
import type { UseFormReturn, FieldValues } from 'react-hook-form';

export interface DebouncedFormSyncControls {
  /** Cancel any pending debounce timer without flushing. Used by
   * submit handlers that already wrote form values to the store
   * synchronously and don't want a stale buffered timer to fire later
   * and overwrite hook-driven setVoice mutations (e.g. clone resolves
   * with sample:'cloned'; a still-buffered timer with form's stale
   * sample:'pending' would otherwise revert the cloned voiceId). */
  cancel: () => void;
}

export function useDebouncedFormSync<V extends FieldValues>(
  form: UseFormReturn<V>,
  onChange: (values: V) => void,
  debounceMs = 300,
): DebouncedFormSyncControls {
  // Last serialized payload we emitted. Stops no-op flushes when watch
  // fires from a `form.reset` round-trip (slice changes → reset →
  // watch sees same values → would re-write the store with a fresh
  // ref → triggers another reset → loop). JSON-stringify is cheap for
  // wizard slices (a few hundred bytes) and dodges deep-equality libs.
  //
  // Safety constraint: form values must JSON-serialize losslessly.
  // Don't put `File` instances or other non-serializable values in form
  // state (callers should write `ServerAsset` only, not `LocalAsset`).
  // A bare File serializes to `{}` and two distinct uploads with the
  // same metadata would compare equal and silently drop the second
  // write.
  const lastEmittedRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const sub = form.watch((values) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const serialized = JSON.stringify(values);
        if (serialized === lastEmittedRef.current) return;
        lastEmittedRef.current = serialized;
        // RHF emits Partial<V> via watch; we cast back since the form
        // is fully populated by defaultValues at mount.
        onChange(values as V);
      }, debounceMs);
    });
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      sub.unsubscribe();
    };
  }, [form, onChange, debounceMs]);

  return useMemo<DebouncedFormSyncControls>(
    () => ({
      cancel: () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      },
    }),
    [],
  );
}
