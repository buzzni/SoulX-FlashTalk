/**
 * WizardField — RHF-aware <Field> wrapper.
 *
 * Bundles label + hint + error-message rendering for a single form
 * field so step pages stop hand-wiring `<label>`, `<input>`, error
 * `<span>` for each input. Reads errors from the surrounding
 * <FormProvider> via `useFormContext` — no per-field error prop
 * threading.
 *
 * Usage:
 *   <FormProvider {...form}>
 *     <WizardField name="prompt" label="대본" hint="15자 이상">
 *       <textarea {...form.register('prompt')} />
 *     </WizardField>
 *   </FormProvider>
 *
 * Children render the actual input — WizardField stays neutral about
 * the input shape (textarea, input, custom select). The `name` prop
 * looks up the corresponding error in `formState.errors`.
 */

import type { ReactNode } from 'react';
import { useFormContext } from 'react-hook-form';
import { Field } from './field';

export interface WizardFieldProps {
  name: string;
  label?: string;
  hint?: string;
  children: ReactNode;
}

export function WizardField({ name, label, hint, children }: WizardFieldProps) {
  const ctx = useFormContext();
  // Walk dot-paths so `name="host.input.prompt"` resolves nested errors.
  const error = name.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in acc) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, ctx?.formState.errors);

  const message = (error as { message?: string } | undefined)?.message;

  return (
    <Field label={label} hint={hint}>
      {children}
      {message && (
        <div
          role="alert"
          className="mt-1 text-xs text-error-on-soft"
          data-testid={`field-error-${name}`}
        >
          {message}
        </div>
      )}
    </Field>
  );
}
