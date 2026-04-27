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

import { useEffect } from 'react';
import type { UseFormReturn, FieldValues } from 'react-hook-form';

export function useDebouncedFormSync<V extends FieldValues>(
  form: UseFormReturn<V>,
  onChange: (values: V) => void,
  debounceMs = 300,
): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = form.watch((values) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // RHF emits Partial<V> via watch; we cast back since the form
        // is fully populated by defaultValues at mount.
        onChange(values as V);
      }, debounceMs);
    });
    return () => {
      if (timer) clearTimeout(timer);
      sub.unsubscribe();
    };
  }, [form, onChange, debounceMs]);
}
