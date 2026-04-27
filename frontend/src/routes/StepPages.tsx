/**
 * Step page wrappers for the /step/:step routes.
 *
 * Lane G adds a per-step <ErrorBoundary> around each Step page so a
 * render-time crash inside Step 2 (for example, an unexpected null
 * inside the variant grid) doesn't take down the whole wizard. The
 * boundary resets when the user clicks "다시 시도" — input values
 * survive because the wizard store owns them, not the component tree.
 *
 * Thin adapters: read from wizardStore, hand state + update down to
 * the existing Step1Host / Step2Composite / Step3Audio trees. When
 * those migrate to subscribing to their own slices (Lane D/F follow-
 * up) these wrappers go away.
 */
import { ErrorBoundary } from 'react-error-boundary';
import Step1Host from '../studio/step1/Step1Host';
import Step2Composite from '../studio/step2/Step2Composite';
import Step3Audio from '../studio/step3/Step3Audio';
import { useWizardStore } from '../stores/wizardStore';
import { StepErrorFallback } from '../components/step-error-fallback';

export function Step1Page() {
  const state = useWizardStore();
  const updateState = useWizardStore((s) => s.updateState);
  const epoch = useWizardStore((s) => s.wizardEpoch);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update = (u: any) => updateState(u);
  // Keying on wizardEpoch forces a remount after `reset()`, which
  // clears hook-local state (variants, prevSelected, batchId) that
  // wouldn't otherwise sync from the now-empty store.
  return (
    <ErrorBoundary
      FallbackComponent={(props) => <StepErrorFallback {...props} step={1} />}
      resetKeys={[epoch]}
    >
      <Step1Host key={epoch} state={state} update={update} />
    </ErrorBoundary>
  );
}

export function Step2Page() {
  const state = useWizardStore();
  const updateState = useWizardStore((s) => s.updateState);
  const epoch = useWizardStore((s) => s.wizardEpoch);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update = (u: any) => updateState(u);
  return (
    <ErrorBoundary
      FallbackComponent={(props) => <StepErrorFallback {...props} step={2} />}
      resetKeys={[epoch]}
    >
      <Step2Composite key={epoch} state={state} update={update} />
    </ErrorBoundary>
  );
}

export function Step3Page() {
  const state = useWizardStore();
  const updateState = useWizardStore((s) => s.updateState);
  const epoch = useWizardStore((s) => s.wizardEpoch);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update = (u: any) => updateState(u);
  return (
    <ErrorBoundary
      FallbackComponent={(props) => <StepErrorFallback {...props} step={3} />}
      resetKeys={[epoch]}
    >
      <Step3Audio key={epoch} state={state} update={update} />
    </ErrorBoundary>
  );
}
