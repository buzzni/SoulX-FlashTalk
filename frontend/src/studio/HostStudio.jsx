// HostStudio main app — stepper, validation, route orchestration.
// Wizard state (host / products / background / composition / voice /
// script / resolution / imageQuality) lives in the Zustand wizardStore
// (Phase 2b). This component owns only the local UI shell state:
// current step, whether we're rendering, and the one-shot ?attach=
// URL pickup. Phase 5 will move `step` / `rendering` / `attachToTaskId`
// into the route itself.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Icon from './Icon.jsx';
import { Button } from './primitives.jsx';
import Step1Host from './step1/Step1Host.tsx';
import Step2Composite from './step2/Step2Composite.tsx';
import Step3Audio from './step3/Step3Audio.tsx';
import PreviewPanel from './PreviewPanel.jsx';
import QueueStatus from './QueueStatus.jsx';
import RenderDashboard from './render/RenderDashboard.tsx';
import { useWizardStore } from '../stores/wizardStore';
import { storageKey } from '../stores/storageKey';

// Global styles (tokens.css / app.css / tailwind.css) now load from
// src/main.jsx so every route gets them on a cold open — previously they
// only loaded when this component mounted, which left /result/:taskId
// unstyled on direct navigation.

const STEPS = [
  { key: 1, name: '쇼호스트', short: '1', full: '쇼호스트 만들기' },
  { key: 2, name: '제품·배경', short: '2', full: '제품과 배경' },
  { key: 3, name: '목소리·영상', short: '3', full: '목소리와 영상 뽑기' },
];

// Resolve the step key lazily (inside the component) rather than at module
// import time, so a future setUserScope() call before HostStudio mounts
// still ends up scoping this key to the right user. Capturing at module
// load would freeze the key to the pre-login global scope, out of sync
// with wizardStore's persist middleware (which reads storageKey() on
// first use inside the store factory).
const HostStudio = () => {
  const STEP_STORAGE_KEY = storageKey('step');
  // Wizard content lives in the Zustand store (persist middleware owns
  // localStorage round-trip + the one-time legacy migration; no manual
  // save/load here).
  //
  // KNOWN LIMITATION (Phase 2b): this subscribes to the entire store,
  // so any `set*` call re-renders HostStudio AND propagates a new
  // `state` prop reference into Step1/2/3 — the "selector ergonomics"
  // win the refactor plan claimed for Zustand is NOT actually
  // delivered yet. Half-measures here (shallow compare, per-slice
  // selectors inside HostStudio) don't help because the whole `state`
  // object is still handed down to children as a prop. The real fix
  // is Phase 4: Step components subscribe to their own slices
  // internally, HostStudio stops passing `state` as a prop. Until
  // then the re-render cost is the same as the pre-refactor
  // `useState(INITIAL_STATE)` — no regression, no improvement.
  const state = useWizardStore();
  const updateState = useWizardStore((s) => s.updateState);
  const resetState = useWizardStore((s) => s.reset);

  const [step, setStep] = useState(() => {
    const raw = Number(localStorage.getItem(STEP_STORAGE_KEY));
    if (!Number.isFinite(raw) || raw < 1) return 1;
    return Math.min(3, Math.max(1, Math.floor(raw)));
  });
  const [rendering, setRendering] = useState(false);
  // When set, RenderDashboard attaches to an existing in-flight task instead
  // of dispatching a new /api/generate. Click-from-queue (running/pending
  // items) lands here via the ?attach=<task_id> URL param.
  const [attachToTaskId, setAttachToTaskId] = useState(null);

  // Pick up ?attach=<task_id> from QueueStatus clicking a running/pending
  // item (it navigates to /?attach=...). One-shot: read it, flip into
  // attach mode, strip the param so refreshing doesn't re-attach forever.
  // Phase 5 replaces this shim with a dedicated /render/:taskId route.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const attachId = searchParams.get('attach');
    if (!attachId) return;
    setAttachToTaskId(attachId);
    setRendering(true);
    const next = new URLSearchParams(searchParams);
    next.delete('attach');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const exitRenderView = () => {
    setRendering(false);
    setAttachToTaskId(null);
  };

  useEffect(() => {
    localStorage.setItem(STEP_STORAGE_KEY, String(step));
  }, [step]);

  // Validation
  const valid = useMemo(() => {
    const v = { 1: false, 2: false, 3: false };
    v[1] = state.host.generated || !!state.host.imageUrl;
    v[2] = v[1] && !!state.composition.generated;
    v[3] = v[2] && !!(state.voice.generated || state.voice.uploadedAudio) && !!state.voice.script && !!state.resolution.key;
    return v;
  }, [state]);

  const canProceed = valid[step];
  const allValid = valid[1] && valid[2] && valid[3];

  const next = () => {
    if (step < 3) setStep(step + 1);
    else if (allValid) {
      // Wizard path — fresh dispatch, not attaching.
      setAttachToTaskId(null);
      setRendering(true);
    }
  };
  const prev = () => setStep(s => Math.max(1, s - 1));

  const reset = () => {
    if (!window.confirm('처음부터 다시 시작할까요?\n지금까지 입력한 내용은 사라져요.')) return;
    resetState();
    setStep(1);
    setRendering(false);
    setAttachToTaskId(null);
  };

  // Legacy update(fn) interface — Step 1/2/3 still call this with either
  // a partial object or a full-state updater function. Phase 4 migrates
  // callers to per-slice setters (setHost, setVoice, …) and this
  // adapter goes away.
  const update = (updater) => updateState(updater);

  const shellProps = {
    className: 'studio-root',
    // density was a knob in the prototype; only "comfortable" survived real
    // use, so we hardcode it rather than carrying state for one value.
    'data-density': 'comfortable',
  };

  // QueueStatus is rendered inside the TopBar's right group now (via the
  // `queueSlot` prop) so it lives in the header instead of floating at the
  // bottom-left. Same instance across wizard and render views; navigation
  // is self-contained (live → /?attach=, completed → /result/:taskId).
  const queueSlot = <QueueStatus />;

  // Queue polling is owned by queueStore (Phase 2a) — no Provider
  // hoisting needed. The 4s interval runs while any component reads
  // from useQueue/useQueueEntry/useQueuePosition, and pauses when
  // nothing is mounted.
  const renderShell = rendering ? (
    <div {...shellProps}>
      <div className="app-shell" data-screen-label="05 Render">
        <TopBar onReset={reset} step={null} queueSlot={queueSlot} />
        <RenderDashboard
          // Re-mount when attachToTaskId changes so clicking a different
          // queue item from QueueStatus while already on the render view
          // tears down the old SSE subscription and starts a fresh one
          // for the newly-clicked task. 'fresh' = dispatch-new path.
          key={attachToTaskId || 'fresh'}
          state={state}
          attachToTaskId={attachToTaskId}
          onBack={exitRenderView}
          onReset={reset}
        />
      </div>
    </div>
  ) : (
    <div {...shellProps}>
      <div className="app-shell" data-screen-label={`0${step} ${STEPS[step - 1].name}`}>
        <TopBar onReset={reset} step={step} valid={valid} onStepClick={setStep} queueSlot={queueSlot} />
        {/* Step 1 hides the right PreviewPanel (candidate grid IS the preview);
            collapse the main grid to a single column so the form gets full width. */}
        <div className="main" style={step === 1 ? { gridTemplateColumns: '1fr' } : undefined}>
          <div className="left-col" style={step === 1 ? { borderRight: 'none' } : undefined}>
            {step === 1 && <Step1Host state={state} update={update} />}
            {step === 2 && <Step2Composite state={state} update={update} />}
            {step === 3 && <Step3Audio state={state} update={update} />}

            <div className="step-footer">
              <Button icon="arrow_left" onClick={prev} disabled={step === 1}>이전</Button>
              <div className="validation-msg">
                {!canProceed && (
                  <>
                    <Icon name="alert_circle" size={13} style={{ color: 'var(--warn)' }} />
                    <span>
                      {step === 1 && '쇼호스트를 만들고 마음에 드는 후보를 하나 골라주세요'}
                      {step === 2 && '제품·배경을 넣고 합성 이미지를 하나 골라주세요'}
                      {step === 3 && '목소리와 대본, 영상 화질을 모두 설정해주세요'}
                    </span>
                  </>
                )}
                {canProceed && step < 3 && (
                  <><Icon name="check_circle" size={13} style={{ color: 'var(--success)' }} /><span>좋아요! 다음 단계로 넘어가세요</span></>
                )}
                {canProceed && step === 3 && allValid && (
                  <><Icon name="check_circle" size={13} style={{ color: 'var(--success)' }} /><span>모든 준비 완료! 영상을 만들어볼까요?</span></>
                )}
              </div>
              <Button variant="primary" iconRight={step === 3 ? 'video' : 'arrow_right'} onClick={next} disabled={!canProceed || (step === 3 && !allValid)}>
                {step === 3 ? '영상 만들기 시작' : '다음 단계'}
              </Button>
            </div>
          </div>

          <PreviewPanel state={state} step={step} />
        </div>
      </div>
    </div>
  );

  return renderShell;
};

const TopBar = ({ step, valid, onStepClick, onReset, queueSlot }) => (
  <header className="topbar">
    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
      <div className="brand">
        <div className="brand-mark">H</div>
        <span>HostStudio</span>
        <span className="brand-tag text-xs text-tertiary" style={{ marginLeft: 6, paddingLeft: 10, borderLeft: '1px solid var(--border)' }}>AI 쇼호스트 영상</span>
      </div>
      {step !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 10 }}>
          {STEPS.map((s, i) => {
            const active = step === s.key;
            const done = valid?.[s.key] && step > s.key;
            return (
              <Fragment key={s.key}>
                <button
                  className={`step-pill ${active ? 'active' : ''} ${done ? 'done' : ''}`}
                  onClick={() => onStepClick(s.key)}
                  title={s.full}
                  aria-current={active ? 'step' : undefined}
                >
                  <span className="dot">{done ? <Icon name="check" size={10} /> : s.short}</span>
                  <span className="step-pill-label">{s.name}</span>
                </button>
                {i < STEPS.length - 1 && <span className="step-arrow" />}
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
    <div className="topbar-right">
      <span className="meta">자동 저장됨</span>
      {queueSlot}
      <Button size="sm" icon="refresh" onClick={onReset}>처음부터 다시</Button>
    </div>
  </header>
);

export default HostStudio;
