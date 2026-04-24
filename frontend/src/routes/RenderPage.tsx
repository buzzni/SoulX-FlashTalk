/**
 * RenderPage — /render and /render/:taskId route adapters.
 *
 * Two flavors:
 *   - /render           → dispatch-new (RenderDashboard fires POST /api/generate
 *                         on mount, then replaces the URL with /render/:taskId
 *                         as soon as the task_id lands).
 *   - /render/:taskId   → attach-mode (RenderDashboard reads live progress for
 *                         the already-running task).
 *
 * The split exists because of a refresh semantic: if someone refreshes on
 * /render (no id), we have no way to recover the in-flight dispatch —
 * useEffect is correct to block the refire, and the wizard guard
 * redirects them back to /step/3 via isAllValid. If they refresh on
 * /render/:taskId, the attach-mode re-picks up the existing job cleanly.
 */
import { Navigate, useParams } from 'react-router-dom';
import RenderLayout from './RenderLayout';
import { useWizardStore } from '../stores/wizardStore';
import {
  computeValidity,
  deepestReachableStep,
  isAllValid,
} from './wizardValidation';

/** /render — no id, dispatch-new mode. Requires a fully-valid wizard
 * state (otherwise there's nothing to dispatch). If the state isn't
 * valid we return a synchronous <Navigate />, so RenderLayout never
 * mounts and RenderDashboard never tries to fire its dispatch against
 * an empty wizard (the prior useEffect-based guard let the child
 * mount for one tick, which made the dispatch throw "no audio path"
 * right before the redirect ran). */
export function RenderDispatchPage() {
  const state = useWizardStore();
  const valid = computeValidity(state);
  if (!isAllValid(valid)) {
    return <Navigate to={`/step/${deepestReachableStep(valid)}`} replace />;
  }
  return <RenderLayout attachToTaskId={null} />;
}

/** /render/:taskId — attach-mode. Always safe to land on: the dashboard
 * shows whatever the queue says about this task, even for tasks owned
 * by someone else's session. */
export function RenderAttachPage() {
  const { taskId } = useParams<{ taskId: string }>();
  return <RenderLayout attachToTaskId={taskId ?? null} />;
}
