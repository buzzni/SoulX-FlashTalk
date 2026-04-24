/**
 * RenderLayout — shell for /render and /render/:taskId.
 *
 * Same TopBar as the wizard but with no step pills (step={null}).
 * Owns the reset flow so "처음부터 다시" wipes the store and drops
 * the user back to step 1.
 */
import { useNavigate } from 'react-router-dom';
import RenderDashboard from '../studio/render/RenderDashboard';
import QueueStatus from '../studio/QueueStatus';
import { useWizardStore } from '../stores/wizardStore';
import { TopBar } from './TopBar';

interface RenderLayoutProps {
  attachToTaskId?: string | null;
}

export default function RenderLayout({ attachToTaskId = null }: RenderLayoutProps) {
  const navigate = useNavigate();
  const state = useWizardStore();
  const resetState = useWizardStore((s) => s.reset);

  const reset = () => {
    if (!window.confirm('처음부터 다시 시작할까요?\n지금까지 입력한 내용은 사라져요.')) return;
    resetState();
    navigate('/step/1');
  };

  const handleBack = () => {
    // From the render view the only sensible "back" target is the last
    // wizard step — the user just came from step 3 for a fresh dispatch,
    // or they landed here from the queue and we want them to be able to
    // tweak and re-run. Step 3 respects the URL-as-source-of-truth model.
    navigate('/step/3');
  };

  return (
    <div className="studio-root" data-density="comfortable">
      <div className="app-shell" data-screen-label="05 Render">
        <TopBar
          step={null}
          onReset={reset}
          queueSlot={<QueueStatus />}
        />
        <RenderDashboard
          // Re-mount when attachToTaskId changes — tears down the old SSE
          // subscription and starts a fresh one for the newly-clicked task.
          key={attachToTaskId || 'fresh'}
          state={state}
          attachToTaskId={attachToTaskId}
          onBack={handleBack}
          onReset={reset}
        />
      </div>
    </div>
  );
}
