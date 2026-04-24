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
import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import RenderLayout from './RenderLayout';
import { useWizardStore } from '../stores/wizardStore';
import { computeValidity, isAllValid } from './wizardValidation';

/** /render — no id, dispatch-new mode. Requires a fully-valid wizard
 * state (otherwise there's nothing to dispatch); otherwise redirect
 * to the deepest reachable step. */
export function RenderDispatchPage() {
  const navigate = useNavigate();
  const state = useWizardStore();

  useEffect(() => {
    const valid = computeValidity(state);
    if (!isAllValid(valid)) {
      // No in-flight job + no usable wizard state = nothing to render.
      // Drop the user at step 1 (or wherever deep-linked reach lands them).
      navigate('/step/1', { replace: true });
    }
  }, [state, navigate]);

  return <RenderLayout attachToTaskId={null} />;
}

/** /render/:taskId — attach-mode. Always safe to land on: the dashboard
 * shows whatever the queue says about this task, even for tasks owned
 * by someone else's session. */
export function RenderAttachPage() {
  const { taskId } = useParams<{ taskId: string }>();
  return <RenderLayout attachToTaskId={taskId ?? null} />;
}
