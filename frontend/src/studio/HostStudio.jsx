// HostStudio main app — state, stepper, validation, tweak panel.
// Ported from prototype App.jsx. Key divergences from prototype:
//   1. postMessage density handshake (prototype App.jsx:40-61) REMOVED — that only
//      existed so the design tool could edit density from a parent frame. Replaced
//      with a localStorage-backed 'showhost_density' key.
//   2. Mounts under div.studio-root (not #root), so it coexists with the existing
//      VideoGenerator / ConversationGenerator app shell.
//   3. Named export HostStudio instead of writing to window / direct ReactDOM.render.
import { Fragment, useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { Button, Field, Segmented } from './primitives.jsx';
import Step1Host from './Step1Host.jsx';
import Step2Composite from './Step2Composite.jsx';
import Step3Audio from './Step3Audio.jsx';
import PreviewPanel from './PreviewPanel.jsx';
import QueueStatus from './QueueStatus.jsx';
import RenderDashboard from './RenderDashboard.jsx';

import './styles/tokens.css';
import './styles/app.css';

const STEPS = [
  { key: 1, name: '쇼호스트', short: '1', full: '쇼호스트 만들기' },
  { key: 2, name: '제품·배경', short: '2', full: '제품과 배경' },
  { key: 3, name: '목소리·영상', short: '3', full: '목소리와 영상 뽑기' },
];

// State fields intentionally cut vs the prototype designer's original shape:
//   - voice.pitch: no ElevenLabs pitch param; ffmpeg rubberband post-processing not built.
//   - voice.bgm / voice.bgmVolume: no BGM mix pipeline in backend.
//   - subtitles / productTag: no captioning / overlay pipeline in backend.
// The prototype's sliders for those widgets were cargo-culted from mockups that
// didn't consider the actual Gemini / ElevenLabs / FlashTalk model capabilities.
const INITIAL_STATE = {
  host: { mode: 'text', prompt: '', negativePrompt: '', builder: {}, generated: false, selectedSeed: null, _gradient: null, faceRef: null, outfitRef: null, faceStrength: 0.7, outfitStrength: 0.5 },
  products: [],
  background: { source: 'preset', preset: null, url: '', prompt: '', imageUrl: null, _gradient: null, _file: null },
  composition: { direction: '', shot: 'medium', angle: 'eye', generated: false, selectedSeed: null },
  voice: { source: 'tts', voiceId: null, voiceName: null, paragraphs: [''], script: '', stability: 0.5, style: 0.3, similarity: 0.75, speed: 1, generated: false, uploadedAudio: null, cloneSample: null },
  script: '',
  resolution: { key: '448p', label: '448p', width: 448, height: 768, size: '~8MB', speed: '빠름', default: true },
};

const DENSITY_KEY = 'showhost_density';

// Defensive hydrator — previous localStorage can have partial or missing sub-objects
// (e.g., an older version of the app shipped without composition.shot). Shallow-
// merge each top-level key with INITIAL_STATE so .host, .voice, etc. always have
// the full shape their Step components assume.
function hydrateState(raw) {
  if (!raw || typeof raw !== 'object') return INITIAL_STATE;
  const merged = { ...INITIAL_STATE };
  for (const k of Object.keys(INITIAL_STATE)) {
    const defaults = INITIAL_STATE[k];
    const incoming = raw[k];
    if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
      merged[k] = { ...defaults, ...(incoming && typeof incoming === 'object' ? incoming : {}) };
    } else if (incoming !== undefined) {
      merged[k] = incoming;
    }
  }
  return merged;
}

const HostStudio = () => {
  const [state, setState] = useState(() => {
    try {
      const saved = localStorage.getItem('showhost_state');
      if (saved) return hydrateState(JSON.parse(saved));
    } catch (e) { /* ignore */ }
    return INITIAL_STATE;
  });
  const [step, setStep] = useState(() => {
    const raw = Number(localStorage.getItem('showhost_step'));
    if (!Number.isFinite(raw) || raw < 1) return 1;
    return Math.min(3, Math.max(1, Math.floor(raw)));
  });
  const [rendering, setRendering] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);

  // Density — localStorage instead of prototype's postMessage handshake.
  const [density, setDensity] = useState(() => {
    try {
      return localStorage.getItem(DENSITY_KEY) || 'comfortable';
    } catch (e) {
      return 'comfortable';
    }
  });
  useEffect(() => {
    try { localStorage.setItem(DENSITY_KEY, density); } catch (e) { /* ignore */ }
  }, [density]);

  useEffect(() => {
    try { localStorage.setItem('showhost_state', JSON.stringify(state)); } catch (e) { /* ignore */ }
  }, [state]);
  useEffect(() => {
    localStorage.setItem('showhost_step', String(step));
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
    else if (allValid) setRendering(true);
  };
  const prev = () => setStep(s => Math.max(1, s - 1));

  const reset = () => {
    if (!window.confirm('처음부터 다시 시작할까요?\n지금까지 입력한 내용은 사라져요.')) return;
    setState(INITIAL_STATE);
    setStep(1);
    setRendering(false);
  };

  const update = (updater) => setState(s => typeof updater === 'function' ? updater(s) : updater);

  const shellProps = {
    className: 'studio-root',
    'data-density': density,
  };

  if (rendering) {
    return (
      <div {...shellProps}>
        <div className="app-shell" data-screen-label="05 Render">
          <TopBar onReset={reset} step={null} onTweaksToggle={() => setTweaksOpen(o => !o)} />
          <RenderDashboard state={state} onBack={() => setRendering(false)} onReset={reset} />
          <QueueStatus />
          {tweaksOpen && (
            <TweaksPanel density={density} setDensity={setDensity} onClose={() => setTweaksOpen(false)} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div {...shellProps}>
      <div className="app-shell" data-screen-label={`0${step} ${STEPS[step - 1].name}`}>
        <TopBar onReset={reset} step={step} valid={valid} onStepClick={setStep} onTweaksToggle={() => setTweaksOpen(o => !o)} />
        <div className="main">
          <div className="left-col">
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

        <QueueStatus />
        {tweaksOpen && (
          <TweaksPanel density={density} setDensity={setDensity} onClose={() => setTweaksOpen(false)} />
        )}
      </div>
    </div>
  );
};

const TweaksPanel = ({ density, setDensity, onClose }) => (
  <div className="tweaks-panel">
    <div className="tweaks-header">
      <h4>화면 설정</h4>
      <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="닫기"><Icon name="close" size={12} /></button>
    </div>
    <Field label="간격" hint="화면이 답답하게 느껴지면 좁게로 바꿔보세요">
      <Segmented
        value={density}
        onChange={v => setDensity(v)}
        options={[{ value: 'comfortable', label: '넓게' }, { value: 'compact', label: '좁게' }]}
      />
    </Field>
  </div>
);

const TopBar = ({ step, valid, onStepClick, onReset, onTweaksToggle }) => (
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
      <Button size="sm" icon="settings" onClick={onTweaksToggle}>설정</Button>
      <Button size="sm" icon="refresh" onClick={onReset}>처음부터 다시</Button>
    </div>
  </header>
);

export default HostStudio;
