// HostStudio main app — state, stepper, validation.
// Mounts under div.studio-root (not #root), so it coexists with the existing
// VideoGenerator / ConversationGenerator app shell. Density "comfortable"
// is now the only mode — the tweaks panel + settings button + localStorage
// density key were removed (2026-04-23) because nobody used the "compact"
// option and the panel cluttered the header.
import { Fragment, useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { Button } from './primitives.jsx';
import Step1Host from './Step1Host.jsx';
import Step2Composite from './Step2Composite.jsx';
import Step3Audio from './Step3Audio.jsx';
import PreviewPanel from './PreviewPanel.jsx';
import QueueStatus from './QueueStatus.jsx';
import RenderDashboard from './RenderDashboard.jsx';
import { QueueProvider } from './QueueContext.jsx';

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
  // `variants` holds the 4 generated candidates for each image stage so a
  // reload doesn't wipe them. Entries have { seed, id, url, path } once
  // complete; placeholder/error entries are scrubbed before persist.
  host: { mode: 'text', prompt: '', negativePrompt: '', builder: {}, generated: false, selectedSeed: null, _gradient: null, faceRef: null, outfitRef: null, outfitText: '', faceStrength: 0.7, outfitStrength: 0.5, temperature: 0.7, variants: [] },
  products: [],
  background: { source: 'preset', preset: null, url: '', prompt: '', imageUrl: null, _gradient: null, _file: null },
  composition: { direction: '', shot: 'medium', angle: 'eye', generated: false, selectedSeed: null, temperature: 0.7, variants: [] },
  voice: { source: 'tts', voiceId: null, voiceName: null, paragraphs: [''], script: '', stability: 0.5, style: 0.3, similarity: 0.75, speed: 1, generated: false, uploadedAudio: null, cloneSample: null },
  script: '',
  resolution: { key: '448p', label: '448p', width: 448, height: 768, size: '~8MB', speed: '빠름', default: true },
  // Shared Gemini image_size ("1K" | "2K") — applied to both Step 1 host
  // and Step 2 composite so reference + output resolutions match. Users
  // set it once in Step 1; Step 2 just follows. 2K is ~2-4× slower.
  imageQuality: '1K',
};

// Drop File handles and blob: URLs before localStorage. Server-side path
// strings (host.selectedPath, products[].path, background.uploadPath) and
// everything else stays so step navigation + validation still work after
// refresh — users just need to re-attach files if they want to re-upload.
function sanitizeForPersist(s) {
  // Strip any URL that can't survive a refresh (blob: dies with the tab,
  // data: is fine but can blow past localStorage quota with multi-MB uploads).
  const isTransientUrl = (u) => typeof u === 'string' && (u.startsWith('blob:') || u.startsWith('data:'));
  // Keep a reference-image entry only if its url is a real server URL. Pre-
  // upload entries (data:/blob:) are transient — the File handle dies on
  // refresh, so resurrecting the preview without a File would just confuse
  // the generate flow. Server URLs (via /api/files/...) are stable forever.
  const cleanRef = (ref) => {
    if (!ref || !ref.url || isTransientUrl(ref.url)) return null;
    return { name: ref.name, size: ref.size, type: ref.type, url: ref.url, _file: undefined };
  };
  // Strip placeholder/error variants — those only make sense during the
  // in-flight stream. Finished entries (with url + path) survive refresh.
  const cleanVariants = (arr) => (arr || []).filter(v => v && !v.placeholder && !v.error && v.url);
  const cleanHost = {
    ...s.host,
    faceRef: cleanRef(s.host?.faceRef),
    outfitRef: cleanRef(s.host?.outfitRef),
    variants: cleanVariants(s.host?.variants),
  };
  const cleanComposition = {
    ...s.composition,
    variants: cleanVariants(s.composition?.variants),
  };
  const cleanBg = { ...s.background, _file: null, imageUrl: isTransientUrl(s.background?.imageUrl) ? null : s.background?.imageUrl };
  const cleanProducts = (s.products || []).map(p => ({
    ...p,
    _file: undefined,
    url: isTransientUrl(p.url) ? null : p.url,
  }));
  const cleanVoice = {
    ...s.voice,
    uploadedAudio: s.voice?.uploadedAudio?.path ? { path: s.voice.uploadedAudio.path, name: s.voice.uploadedAudio.name } : null,
    cloneSample: s.voice?.cloneSample?.voiceId ? { voiceId: s.voice.cloneSample.voiceId, name: s.voice.cloneSample.name } : null,
  };
  return {
    ...s,
    host: cleanHost,
    composition: cleanComposition,
    background: cleanBg,
    products: cleanProducts,
    voice: cleanVoice,
  };
}

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

// Exported for tests — round-trip coverage in __tests__/state_persist.test.js
// ensures the variants + face/outfit refs survive a reload.
export { sanitizeForPersist, hydrateState, INITIAL_STATE };

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
  // When set, RenderDashboard attaches to an existing in-flight task instead
  // of dispatching a new /api/generate. Click-from-queue jumps here.
  const [attachToTaskId, setAttachToTaskId] = useState(null);

  // Open RenderDashboard for an already-running/pending task (clicked in
  // QueueStatus). Different entry from the wizard's "영상 만들기 시작" path
  // because we don't want to redispatch — just monitor the existing job.
  const openTaskInRenderView = (taskId) => {
    if (!taskId) return;
    setAttachToTaskId(taskId);
    setRendering(true);
  };

  const exitRenderView = () => {
    setRendering(false);
    setAttachToTaskId(null);
  };


  useEffect(() => {
    // Strip transient fields that can't survive a page refresh:
    //   - blob URLs (URL.createObjectURL is session-scoped)
    //   - File objects (JSON.stringify drops them to {} which then looks like
    //     "a File is still here" but all real handles are gone — causing the
    //     upload call to FormData.append a plain {} and produce "[object Object]")
    try {
      const sanitized = sanitizeForPersist(state);
      localStorage.setItem('showhost_state', JSON.stringify(sanitized));
    } catch (e) { /* ignore */ }
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
    else if (allValid) {
      // Wizard path — fresh dispatch, not attaching.
      setAttachToTaskId(null);
      setRendering(true);
    }
  };
  const prev = () => setStep(s => Math.max(1, s - 1));

  const reset = () => {
    if (!window.confirm('처음부터 다시 시작할까요?\n지금까지 입력한 내용은 사라져요.')) return;
    setState(INITIAL_STATE);
    setStep(1);
    setRendering(false);
    setAttachToTaskId(null);
  };

  const update = (updater) => setState(s => typeof updater === 'function' ? updater(s) : updater);

  const shellProps = {
    className: 'studio-root',
    // density was a knob in the prototype; only "comfortable" survived real
    // use, so we hardcode it rather than carrying state for one value.
    'data-density': 'comfortable',
  };

  // QueueStatus is rendered inside the TopBar's right group now (via the
  // `queueSlot` prop) so it lives in the header instead of floating at the
  // bottom-left. Same instance across wizard and render views — passes the
  // click-to-attach handler through so finished tasks can open too.
  const queueSlot = <QueueStatus onTaskClick={openTaskInRenderView} />;

  // QueueProvider hoisted to the SINGLE outermost wrapper so its 4s polling
  // interval survives wizard ↔ render view switches.
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

  return <QueueProvider>{renderShell}</QueueProvider>;
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
