/**
 * Step3Audio — wizard Step 3 container.
 *
 * Top-level decision: "AI로 음성 만들기" vs "내 녹음 그대로 쓰기" — these
 * trigger fundamentally different pipelines (TTS+timing vs raw audio
 * passthrough). Inside "AI 음성", a sub-tab swaps between stock voice
 * picker and voice clone uploader. Both sub-modes share the script
 * editor + speed + advanced + generate CTA.
 *
 * `voice.source` carries both decisions:
 *   'tts'    → AI on, stock voice
 *   'clone'  → AI on, cloned voice
 *   'upload' → AI off, raw audio bypass
 */

import { useEffect, useState } from 'react';
import { Sparkles, Mic, Copy, MicVocal, Film, Volume2, FileText, Monitor } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Icon from '../Icon.jsx';
import { WizardBadge as Badge } from '@/components/wizard-badge';
import { WizardCard as Card } from '@/components/wizard-card';
import { OptionCard } from '@/components/option-card';
import { humanizeError } from '../../api/http';
import { uploadAudio } from '../../api/upload';
import { useVoiceList } from '../../hooks/useVoiceList';
import { useTTSGeneration } from '../../hooks/useTTSGeneration';
import { useVoiceClone } from '../../hooks/useVoiceClone';
import { useUploadReferenceImage } from '../../hooks/useUploadReferenceImage';
import { useWizardStore } from '../../stores/wizardStore';
import { isLocalAsset, isServerAsset } from '@/wizard/normalizers';
import {
  INITIAL_VOICE,
  RESOLUTION_META,
  isHostReady,
  isCompositionReady,
} from '@/wizard/schema';
import type {
  Composition,
  Host,
  ResolutionKey,
  Script,
  Voice,
  VoiceAdvanced,
  VoiceCloneSample,
} from '@/wizard/schema';
import { AudioPlayer } from '../shared/AudioPlayer';
import { VoicePicker } from './VoicePicker';
import { VoiceCloner } from './VoiceCloner';
import { AudioUploader } from './AudioUploader';
import { ScriptEditor, buildScript } from './ScriptEditor';
import { VoiceAdvancedSettings } from './VoiceAdvancedSettings';
import { ResolutionPicker } from './ResolutionPicker';
import { PlaylistPicker } from './PlaylistPicker';
import { WizardTabs, WizardTab } from '@/components/wizard-tabs';
import { StepHeading } from '@/routes/StepHeading';
import { computeValidity, isAllValid } from '@/routes/wizardValidation';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UpdateFn = (updater: (state: any) => any) => void;

interface Step3AudioState {
  voice: Voice;
  resolution: ResolutionKey;
  host?: Host | null;
  composition?: Composition | null;
  playlist_id?: string | null;
}

export interface Step3AudioProps {
  state: Step3AudioState & Record<string, unknown>;
  update: UpdateFn;
}

// ────────────────────────────────────────────────────────────────────
// Source-mode transitions — materialize a fresh Voice in the target
// shape while preserving carry-over fields (script, advanced) where
// the union members agree on them.
// ────────────────────────────────────────────────────────────────────

// Carry-over helpers — script lives on every Voice variant; advanced
// only on tts/clone. Switching from upload back to AI defaults the
// sliders to schema initials rather than carrying over (there's
// nothing to carry from).
const FALLBACK_ADVANCED: VoiceAdvanced =
  INITIAL_VOICE.source === 'upload'
    ? { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 }
    : INITIAL_VOICE.advanced;

function commonScript(prev: Voice): Script {
  return prev.script;
}
function commonAdvanced(prev: Voice): VoiceAdvanced {
  return prev.source === 'upload' ? FALLBACK_ADVANCED : prev.advanced;
}

function toTTS(prev: Voice): Voice {
  if (prev.source === 'tts') return prev;
  return {
    source: 'tts',
    voiceId: null,
    voiceName: null,
    advanced: commonAdvanced(prev),
    script: commonScript(prev),
    generation: { state: 'idle' },
  };
}

function toClone(prev: Voice): Voice {
  if (prev.source === 'clone') return prev;
  return {
    source: 'clone',
    sample: { state: 'empty' },
    advanced: commonAdvanced(prev),
    script: commonScript(prev),
    generation: { state: 'idle' },
  };
}

function toUpload(prev: Voice): Voice {
  if (prev.source === 'upload') return prev;
  return {
    source: 'upload',
    audio: null,
    script: commonScript(prev),
  };
}

export default function Step3Audio({ state, update }: Step3AudioProps) {
  const voice: Voice = state.voice;
  const resolution: ResolutionKey = state.resolution;
  const setVoice = useWizardStore((s) => s.setVoice);

  const voiceList = useVoiceList();
  const tts = useTTSGeneration();
  const cloner = useVoiceClone();
  const audioUpload = useUploadReferenceImage(uploadAudio);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isAi = voice.source !== 'upload';
  const aiSubMode: 'tts' | 'clone' = voice.source === 'clone' ? 'clone' : 'tts';

  // ── Mode switches ────────────────────────────────────────────────
  const switchToAi = () => {
    if (voice.source === 'upload') setVoice(toTTS);
  };
  const switchToRawAudio = () => {
    if (voice.source !== 'upload') setVoice(toUpload);
  };
  const switchAiSubMode = (next: 'tts' | 'clone') => {
    if (voice.source === next) return;
    setVoice(next === 'tts' ? toTTS : toClone);
  };

  // ── Eager upload — when upload-mode voice has a LocalAsset audio
  //    pending, kick off /api/upload/audio and replace it with the
  //    returned ServerAsset. Skip if already a ServerAsset or null.
  //    The hook's epoch contract makes stale results from a superseded
  //    pick land harmlessly. ────────────────────────────────────────
  useEffect(() => {
    if (voice.source !== 'upload') return;
    if (!voice.audio || !isLocalAsset(voice.audio)) return;
    const local = voice.audio;
    let alive = true;
    (async () => {
      const res = await audioUpload.upload(local.file);
      if (!alive || !res?.path) return;
      setVoice((prev) => {
        if (prev.source !== 'upload') return prev;
        // Defensive: only swap if the local asset we started uploading
        // is still the current one (user didn't replace mid-upload).
        if (!prev.audio || !isLocalAsset(prev.audio) || prev.audio.file !== local.file) {
          return prev;
        }
        return {
          ...prev,
          audio: { path: res.path as string, url: typeof res.url === 'string' ? res.url : undefined, name: local.name },
        };
      });
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.source === 'upload' ? voice.audio : null]);

  // ── Derived display values ──────────────────────────────────────
  const combinedScript = buildScript(voice.script.paragraphs);
  const estDuration = Math.round(
    combinedScript.replace(/\[breath\]/g, '').replace(/\s+/g, '').length * 0.3,
  );
  const generatedSrc = (() => {
    if (voice.source === 'upload') return null;
    if (voice.generation.state !== 'ready') return null;
    return voice.generation.audio.url || null;
  })();
  const isGenerated = voice.source !== 'upload' && voice.generation.state === 'ready';

  // ── Generate CTA orchestration ──────────────────────────────────
  const handleGenerate = async () => {
    if (voice.source === 'upload') return;
    setErrorMsg(null);
    try {
      // Clone mode with a pending sample needs the clone API call
      // first — that flips sample.state to 'cloned' on success, which
      // toVoiceGenerateRequest then reads as the voice_id.
      if (voice.source === 'clone' && voice.sample.state === 'pending') {
        const cloneResult = await cloner.clone(voice.sample.asset.file);
        if (!cloneResult?.voice_id) return; // hook surfaces error
      }
      if (voice.source === 'clone' && voice.sample.state === 'empty') {
        throw new Error('클론용 샘플 음성을 올려주세요');
      }
      if (voice.source === 'tts' && !voice.voiceId) {
        throw new Error('목소리를 먼저 골라주세요');
      }
      const result = await tts.generate();
      if (!result) return;
    } catch (err) {
      setErrorMsg(humanizeError(err));
    }
  };

  // audioUpload runs in upload-mode only, where the AI Generate CTA
  // doesn't render; safe to scope `generating` to the AI hooks.
  const generating = tts.isLoading || cloner.isLoading;
  const canGenerate = (() => {
    if (voice.source === 'upload') return false;
    if (!combinedScript) return false;
    if (voice.source === 'tts') return !!voice.voiceId;
    if (voice.source === 'clone')
      return voice.sample.state === 'cloned' || voice.sample.state === 'pending';
    return false;
  })();

  // ── Subscriber bridges back to the legacy `update` prop for the
  //    handful of fields that aren't on the voice slice (resolution,
  //    playlist_id). Phase 3 replaces this with per-slice setters. ──
  const setR = (r: ResolutionKey) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update((s: any) => ({ ...s, resolution: r }));

  return (
    <div className="step-page-split step-page-split--65-35">
      <div className="step-page-form">
        <StepHeading
          step={3}
          title="목소리와 영상"
          description="영상에 어떤 소리가 들어갈지 정하고, 화질까지 골라주세요."
          eyebrow="영상 위저드"
        />

        {/* Top-level mode cards — AI vs raw audio */}
        <div className="grid grid-cols-2 gap-3">
          <OptionCard
            active={isAi}
            icon={<Sparkles className="size-4" />}
            title="AI로 음성 만들기"
            desc="대본을 적으면 AI가 읽어줘요"
            meta="~10초 소요"
            onClick={switchToAi}
          />
          <OptionCard
            active={!isAi}
            icon={<MicVocal className="size-4" />}
            title="내 녹음 그대로 쓰기"
            desc="이미 녹음한 음성 파일을 사용해요"
            meta="즉시 적용"
            onClick={switchToRawAudio}
          />
        </div>

        {/* AI mode body — TS narrows voice.source via the `isAi` alias
         * (control-flow analysis of aliased conditions). */}
        {isAi && (
          <Card>
            <div className="mb-4">
              <WizardTabs value={aiSubMode} onValueChange={(v) => switchAiSubMode(v as 'tts' | 'clone')}>
                <WizardTab value="tts" icon={<Mic className="size-3.5" />}>
                  목소리 고르기
                </WizardTab>
                <WizardTab value="clone" icon={<Copy className="size-3.5" />}>
                  내 목소리 복제
                </WizardTab>
              </WizardTabs>
            </div>

            <div className="min-h-[280px]">
              {voice.source === 'tts' && (
                <VoicePicker
                  selectedVoiceId={voice.voiceId}
                  remoteVoices={voiceList.isLoading ? null : voiceList.voices}
                  loadError={voiceList.error}
                  onVoiceSelected={(v) =>
                    setVoice((prev) => {
                      if (prev.source !== 'tts') return prev;
                      return { ...prev, voiceId: v.id, voiceName: v.name };
                    })
                  }
                />
              )}
              {voice.source === 'clone' && (
                <VoiceCloner
                  sample={voice.sample}
                  onSampleChange={(sample: VoiceCloneSample) =>
                    setVoice((prev) => {
                      if (prev.source !== 'clone') return prev;
                      // Re-staging a sample resets the generation —
                      // any prior TTS run was for a different voice.
                      return { ...prev, sample, generation: { state: 'idle' } };
                    })
                  }
                />
              )}
            </div>

            <hr className="hr" />

            <ScriptEditor
              script={voice.script}
              onScriptChange={(script: Script) =>
                setVoice((prev) => {
                  if (prev.source === 'upload') return { ...prev, script };
                  return { ...prev, script };
                })
              }
            />

            <VoiceAdvancedSettings
              advanced={voice.advanced}
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
              onAdvancedChange={(advanced: VoiceAdvanced) =>
                setVoice((prev) => {
                  if (prev.source === 'upload') return prev;
                  return { ...prev, advanced };
                })
              }
            />

            {errorMsg && (
              <div
                style={{
                  padding: '10px 12px',
                  background: 'var(--danger-soft)',
                  border: '1px solid var(--danger)',
                  borderRadius: 'var(--r-sm)',
                  color: 'var(--danger)',
                  fontSize: 12,
                }}
              >
                <Icon name="alert_circle" size={13} style={{ marginRight: 6 }} />
                {errorMsg}
              </div>
            )}

            <GenerateBar
              label={
                isGenerated
                  ? `음성 준비 완료 · ${estDuration}초`
                  : '대본 입력 후 만들기 버튼을 누르면 ~10초 안에 음성이 만들어져요'
              }
              done={isGenerated}
              disabled={generating || !canGenerate}
              generating={generating}
              onClick={handleGenerate}
              cta="음성 만들기"
              timeHint="~10초"
            />

            {isGenerated && generatedSrc && <AudioPlayer src={generatedSrc} />}
          </Card>
        )}

        {/* Raw audio mode body */}
        {voice.source === 'upload' && (
          <Card>
            <div className="min-h-[280px]">
              <AudioUploader
                audio={voice.audio}
                script={voice.script}
                isUploading={audioUpload.isLoading}
                onAudioChange={(audio) =>
                  setVoice((prev) => {
                    if (prev.source !== 'upload') return prev;
                    return { ...prev, audio };
                  })
                }
                onScriptChange={(script: Script) =>
                  setVoice((prev) => {
                    if (prev.source !== 'upload') return prev;
                    return { ...prev, script };
                  })
                }
              />
            </div>
            {voice.audio && isServerAsset(voice.audio) && (
              <div className="mt-3 flex items-center gap-2">
                <Badge variant="success" icon="check_circle">
                  음성 준비 완료
                </Badge>
                <span className="text-xs text-tertiary">TTS를 거치지 않고 그대로 영상에 들어가요</span>
              </div>
            )}
          </Card>
        )}

        <Card title="영상 화질" subtitle="세로 영상 · 어디에 올릴지에 맞춰서 고르세요">
          <ResolutionPicker selectedKey={resolution} onSelect={setR} />
        </Card>

        <Card title="플레이리스트" subtitle="만들어진 영상을 묶어두는 폴더예요. 비워두면 미지정에 저장됩니다.">
          <PlaylistPicker
            selected={state.playlist_id ?? null}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onChange={(pid) => update((s: any) => ({ ...s, playlist_id: pid }))}
          />
        </Card>
      </div>

      {/* RIGHT — pre-render review booth. The composite (Step 2's
       * output) is the visual confidence anchor; voice/script/resolution
       * collapse into one stat block; the big "영상 만들기" CTA lives
       * here so the user commits without scrolling away from the
       * preview. Codex framing: "pre-render review booth, not form
       * completion". */}
      <div className="step-page-canvas">
        <RenderBooth state={state} estDuration={estDuration} />
      </div>
    </div>
  );
}

interface RenderBoothProps {
  state: Step3AudioState & Record<string, unknown>;
  estDuration: number;
}

function RenderBooth({ state, estDuration }: RenderBoothProps) {
  const navigate = useNavigate();
  const valid = computeValidity(state);
  const allValid = isAllValid(valid);

  const composite = state.composition && isCompositionReady(state.composition)
    ? state.composition.generation.state === 'ready' ? state.composition.generation.selected : null
    : null;
  const host = state.host && isHostReady(state.host)
    ? state.host.generation.state === 'ready' ? state.host.generation.selected : null
    : null;
  const compositeUrl = composite?.url ?? undefined;
  const hostUrl = host?.url ?? undefined;
  const heroUrl = compositeUrl || hostUrl || null;
  const heroLabel = compositeUrl ? '합성 결과' : hostUrl ? '쇼호스트 (합성 전)' : '미리보기 없음';

  const voice = state.voice;
  const voiceLine = (() => {
    if (voice.source === 'upload') {
      const name = voice.audio
        ? isServerAsset(voice.audio)
          ? voice.audio.name ?? '파일'
          : voice.audio.name
        : '파일';
      return `내 녹음 · ${name}`;
    }
    if (voice.source === 'clone') {
      const sampleName = voice.sample.state === 'cloned' ? voice.sample.name : null;
      return `내 목소리 복제${sampleName ? ` · ${sampleName}` : ''}`;
    }
    return voice.voiceName ? `AI 음성 · ${voice.voiceName}` : 'AI 음성 — 목소리 미선택';
  })();
  const scriptLen = buildScript(voice.script.paragraphs).length;
  const resolution = state.resolution;
  const resMeta = resolution ? RESOLUTION_META[resolution] : null;
  const resLine = resMeta
    ? `${resMeta.label} · ${resMeta.key} · ${resMeta.width}×${resMeta.height}`
    : '화질 미선택';

  return (
    <section className="render-booth">
      <header className="render-booth__header">
        <span className="render-booth__eyebrow">렌더 미리보기</span>
        <h2 className="render-booth__title">영상 만들기 직전이에요</h2>
      </header>

      <figure className="render-booth__hero">
        {heroUrl ? (
          <img
            src={heroUrl}
            alt={heroLabel}
            className="render-booth__img"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="render-booth__hero-empty">
            <Film className="size-6" strokeWidth={1.4} />
            <span>합성 결과가 여기에 들어가요</span>
          </div>
        )}
        <figcaption className="render-booth__caption">{heroLabel}</figcaption>
      </figure>

      <dl className="render-booth__facts">
        <div className="render-fact">
          <dt>
            <Volume2 className="size-3" strokeWidth={2.2} /> 음성
          </dt>
          <dd>{voiceLine}</dd>
        </div>
        <div className="render-fact">
          <dt>
            <FileText className="size-3" strokeWidth={2.2} /> 대본
          </dt>
          <dd>
            {scriptLen > 0 ? `${scriptLen.toLocaleString()}자 · 약 ${estDuration}초` : '대본을 적어주세요'}
          </dd>
        </div>
        <div className="render-fact">
          <dt>
            <Monitor className="size-3" strokeWidth={2.2} /> 화질
          </dt>
          <dd>{resLine}</dd>
        </div>
      </dl>

      <button
        type="button"
        className="render-booth__cta"
        disabled={!allValid}
        onClick={() => navigate('/render')}
      >
        <Sparkles className="size-4" strokeWidth={2.2} />
        <span>영상 만들기 시작</span>
      </button>
      {!allValid && (
        <p className="render-booth__hint">
          {!valid[1]
            ? '먼저 쇼호스트를 만들어야 해요'
            : !valid[2]
              ? '제품·배경 합성을 끝내야 해요'
              : '음성과 대본까지 정해주세요'}
        </p>
      )}
    </section>
  );
}

interface GenerateBarProps {
  label: React.ReactNode;
  done: boolean;
  disabled: boolean;
  generating: boolean;
  onClick: () => void;
  cta: string;
  timeHint: string;
}

function GenerateBar({ label, done, disabled, generating, onClick, cta, timeHint }: GenerateBarProps) {
  return (
    <div className="flex justify-between items-center gap-3 pt-1">
      <div className={`text-[12.5px] flex items-center gap-2 ${done ? '' : 'text-muted-foreground'}`}>
        {done && (
          <Badge variant="success" icon="check_circle">
            {label}
          </Badge>
        )}
        {!done && <span>{label}</span>}
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="inline-flex items-center gap-2 h-10 px-5 rounded-md bg-primary text-primary-foreground text-[13.5px] font-bold hover:bg-[var(--primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
      >
        {generating ? (
          <>
            <span className="spinner" /> 만드는 중
          </>
        ) : (
          <>
            <Sparkles className="size-4" />
            <span>{cta}</span>
            <span className="text-[11px] font-medium opacity-70 tabular-nums">{timeHint}</span>
          </>
        )}
      </button>
    </div>
  );
}
