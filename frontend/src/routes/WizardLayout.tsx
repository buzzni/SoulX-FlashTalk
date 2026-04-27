/**
 * WizardLayout — shell for /step/:step.
 *
 * Owns validation / reset / navigation plumbing. Each step page controls
 * its own internal layout (gallery-dominant for Step 1, canvas-split for
 * Step 2, preview-dock for Step 3). No universal right rail — that
 * pattern collapsed every step into the same SaaS-default summary.
 *
 * Guard behavior: deep-linking to /step/3 without satisfying step 2
 * redirects to the deepest reachable step.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import QueueStatus from '../studio/QueueStatus';
import { WizardButton as Button } from '@/components/wizard-button';
import { WizardModal as Modal } from '@/components/wizard-modal';
import { useWizardStore } from '../stores/wizardStore';
import { startNewVideo } from '../lib/wizardNav';
import { TopBar, STEPS } from './TopBar';
import { StepFooter } from './StepFooter';
import {
  computeValidity,
  deepestReachableStep,
  isAllValid,
} from './wizardValidation';

type StepNum = 1 | 2 | 3;

function parseStepFromPath(pathname: string): StepNum | null {
  const m = /^\/step\/(1|2|3)\/?$/.exec(pathname);
  if (!m) return null;
  return Number(m[1]) as StepNum;
}

interface WizardLayoutProps {
  children: ReactNode;
}

export default function WizardLayout({ children }: WizardLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();

  // Subscribe to the whole store so validity recomputes on any change.
  // Each step page subscribes to its own slice — this layer only needs
  // the validity bits for routing guards + step footer.
  const state = useWizardStore();
  const [resetOpen, setResetOpen] = useState(false);

  const valid = useMemo(() => computeValidity(state), [state]);
  const parsed = parseStepFromPath(location.pathname);

  // Guard: redirect bad URLs (/step/foo, /step/4) and unreachable
  // deep-links (/step/3 without step 2 done) to a sane target.
  // Synchronous Navigate (not useEffect) so the step page never mounts
  // for a tick before the redirect takes effect — that lag made Step2
  // hit its missing-host preconditions and log noise to the console.
  if (parsed === null) {
    return <Navigate to={`/step/${deepestReachableStep(valid)}`} replace />;
  }
  if (parsed === 2 && !valid[1]) {
    return <Navigate to="/step/1" replace />;
  }
  if (parsed === 3 && !valid[2]) {
    return <Navigate to={`/step/${deepestReachableStep(valid)}`} replace />;
  }

  const step: StepNum = parsed;

  const goto = (s: StepNum) => navigate(`/step/${s}`);
  const next = () => {
    if (step < 3) goto((step + 1) as StepNum);
    else if (isAllValid(valid)) navigate('/render');
  };
  const prev = () => {
    if (step > 1) goto((step - 1) as StepNum);
  };
  const confirmReset = () => {
    setResetOpen(false);
    startNewVideo(navigate);
  };

  // Only jump to a step the user has already reached (or the current one).
  const handleStepClick = (target: StepNum) => {
    if (target === step) return;
    if (target === 1) goto(1);
    else if (target === 2 && valid[1]) goto(2);
    else if (target === 3 && valid[2]) goto(3);
    // Otherwise: silently ignore — they haven't earned that step yet.
  };

  return (
    <div className="studio-root" data-density="comfortable">
      <div
        className="app-shell"
        data-screen-label={`0${step} ${STEPS[step - 1]!.name}`}
      >
        <TopBar
          step={step}
          valid={valid}
          onStepClick={handleStepClick}
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
          <p className="m-0 leading-[1.6]">
            지금까지 입력한 쇼호스트, 제품, 배경, 음성 설정이 모두 사라져요.
            <br />
            진행 중인 영상 작업이 있다면 그건 영향을 받지 않아요.
          </p>
        </Modal>
        <div className="main wizard-main">
          <div className="wizard-stage">{children}</div>
          <StepFooter step={step} valid={valid} onPrev={prev} onNext={next} />
        </div>
      </div>
    </div>
  );
}
