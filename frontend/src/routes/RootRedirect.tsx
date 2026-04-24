/**
 * RootRedirect — the `/` entry point.
 *
 * Reads wizard state from the store and jumps to the deepest step the
 * user has already reached. On a cold open with no state, that's step 1;
 * after a reload mid-flow, the user lands where they left off instead
 * of being forced through the earlier steps again.
 */
import { Navigate } from 'react-router-dom';
import { useWizardStore } from '../stores/wizardStore';
import { computeValidity, deepestReachableStep } from './wizardValidation';

export function RootRedirect() {
  const state = useWizardStore();
  const valid = computeValidity(state);
  const target = deepestReachableStep(valid);
  return <Navigate to={`/step/${target}`} replace />;
}
