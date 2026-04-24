/**
 * Step page wrappers for the /step/:step routes.
 *
 * Thin adapters: read from wizardStore, hand state + update down to the
 * existing Step1Host / Step2Composite / Step3Audio trees. When those
 * migrate to subscribing to their own slices (a future polish) these
 * wrappers go away.
 */
import Step1Host from '../studio/step1/Step1Host';
import Step2Composite from '../studio/step2/Step2Composite';
import Step3Audio from '../studio/step3/Step3Audio';
import { useWizardStore } from '../stores/wizardStore';

export function Step1Page() {
  const state = useWizardStore();
  const updateState = useWizardStore((s) => s.updateState);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update = (u: any) => updateState(u);
  return <Step1Host state={state} update={update} />;
}

export function Step2Page() {
  const state = useWizardStore();
  const updateState = useWizardStore((s) => s.updateState);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update = (u: any) => updateState(u);
  return <Step2Composite state={state} update={update} />;
}

export function Step3Page() {
  const state = useWizardStore();
  const updateState = useWizardStore((s) => s.updateState);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update = (u: any) => updateState(u);
  return <Step3Audio state={state} update={update} />;
}
