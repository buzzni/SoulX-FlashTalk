/**
 * RenderLayout — shell for /render and /render/:taskId.
 *
 * Same TopBar as the wizard but with no step pills (step={null}).
 * Owns the reset flow so "처음부터 다시" wipes the store and drops
 * the user back to step 1.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import RenderDashboard from '../studio/render/RenderDashboard';
import QueueStatus from '../studio/QueueStatus';
import { WizardButton as Button } from '@/components/wizard-button';
import { WizardModal as Modal } from '@/components/wizard-modal';
import { useWizardStore } from '../stores/wizardStore';
import { TopBar } from './TopBar';
import { computeValidity, deepestReachableStep } from './wizardValidation';

interface RenderLayoutProps {
  attachToTaskId?: string | null;
}

export default function RenderLayout({ attachToTaskId = null }: RenderLayoutProps) {
  const navigate = useNavigate();
  const state = useWizardStore();
  const resetState = useWizardStore((s) => s.reset);
  const [resetOpen, setResetOpen] = useState(false);

  const confirmReset = () => {
    setResetOpen(false);
    resetState();
    navigate('/step/1');
  };

  const handleBack = () => {
    // Navigate to the deepest wizard step the user has actually earned.
    // Dispatch-from-step-3 case: wizard is fully valid, this lands at
    // /step/3 as before. Queue-click-attach case: user may have empty
    // wizard state (e.g. opened /render/:taskId in a fresh session),
    // in which case /step/3 would just get bounced to /step/1 by the
    // WizardLayout guard. Computing the deepest reachable step up
    // front avoids that bounce and matches what the button label
    // promises — "go back to a place you can actually work from".
    const valid = computeValidity(state);
    navigate(`/step/${deepestReachableStep(valid)}`);
  };

  return (
    <div className="studio-root" data-density="comfortable">
      <div className="app-shell" data-screen-label="05 Render">
        <TopBar
          step={null}
          onReset={() => setResetOpen(true)}
          queueSlot={<QueueStatus />}
        />
        <Modal
          open={resetOpen}
          onClose={() => setResetOpen(false)}
          title="처음부터 다시 시작할까요?"
          footer={
            <>
              <Button variant="secondary" onClick={() => setResetOpen(false)}>
                취소
              </Button>
              <Button variant="danger" icon="refresh" onClick={confirmReset}>
                다시 시작
              </Button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.6 }}>
            지금까지 입력한 쇼호스트, 제품, 배경, 음성 설정이 모두 사라져요.
            <br />
            진행 중인 영상 작업이 있다면 그건 영향을 받지 않아요.
          </p>
        </Modal>
        <RenderDashboard
          // Re-mount when attachToTaskId changes — tears down the old SSE
          // subscription and starts a fresh one for the newly-clicked task.
          key={attachToTaskId || 'fresh'}
          state={state}
          attachToTaskId={attachToTaskId}
          onBack={handleBack}
          onReset={() => setResetOpen(true)}
        />
      </div>
    </div>
  );
}
