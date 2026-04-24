/**
 * WizardLayout — shell for /step/:step.
 *
 * Owns the validation / reset / navigation plumbing so each step page
 * only has to render its own form. The current step is read from the
 * URL (not local state); refreshing on /step/2 keeps you on step 2,
 * which was the original user pain point this route overhaul exists to fix.
 *
 * Guard behavior: if you deep-link to /step/3 but haven't finished
 * step 2, you get redirected to the deepest reachable step. This
 * prevents showing a step 3 form that references missing step 2
 * state (e.g. no composite image to preview).
 */
import { useEffect, useMemo, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import PreviewPanel from '../studio/PreviewPanel.jsx';
import QueueStatus from '../studio/QueueStatus';
import { useWizardStore } from '../stores/wizardStore';
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

  // Whole-store subscription is fine here — wizard fields are the
  // substance of the view. Selector ergonomics will matter when we move
  // each step to subscribe to its own slice in a later pass; for now
  // the render cost equals the pre-refactor useState shell.
  const state = useWizardStore();
  const resetState = useWizardStore((s) => s.reset);

  const valid = useMemo(() => computeValidity(state), [state]);
  const parsed = parseStepFromPath(location.pathname);

  // Guard: redirect bad URLs (/step/foo, /step/4) and unreachable
  // deep-links (/step/3 without step 2 done) to a sane target.
  useEffect(() => {
    if (parsed === null) {
      navigate(`/step/${deepestReachableStep(valid)}`, { replace: true });
      return;
    }
    if (parsed === 2 && !valid[1]) {
      navigate('/step/1', { replace: true });
      return;
    }
    if (parsed === 3 && !valid[2]) {
      navigate(`/step/${deepestReachableStep(valid)}`, { replace: true });
    }
  }, [parsed, valid, navigate]);

  if (parsed === null) return null; // guard will redirect on next tick

  const step: StepNum = parsed;

  const goto = (s: StepNum) => navigate(`/step/${s}`);
  const next = () => {
    if (step < 3) goto((step + 1) as StepNum);
    else if (isAllValid(valid)) navigate('/render');
  };
  const prev = () => {
    if (step > 1) goto((step - 1) as StepNum);
  };
  const reset = () => {
    if (!window.confirm('처음부터 다시 시작할까요?\n지금까지 입력한 내용은 사라져요.')) return;
    resetState();
    navigate('/step/1');
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
          onReset={reset}
          queueSlot={<QueueStatus />}
        />
        <div
          className="main"
          style={step === 1 ? { gridTemplateColumns: '1fr' } : undefined}
        >
          <div
            className="left-col"
            style={step === 1 ? { borderRight: 'none' } : undefined}
          >
            {children}
            <StepFooter step={step} valid={valid} onPrev={prev} onNext={next} />
          </div>
          {step !== 1 && <PreviewPanel state={state} step={step} />}
        </div>
      </div>
    </div>
  );
}
