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
 *
 * Owns a react-hook-form instance whose values mirror the voice slice
 * MINUS `generation` (the SSE/TTS state machine). Subscribing to
 * narrow voice fields (source / script / advanced / voiceId / voiceName /
 * sample / audio — NOT the whole `voice` slice) keeps SSE/TTS
 * lifecycle mutations from triggering a form.reset that would wipe
 * in-progress edits. Mode swaps go through the form via setValue;
 * useDebouncedFormSync flushes back to the store every 300ms idle.
 *
 * Resolution and playlistId stay on the legacy `update` prop — they're
 * top-level wizard state, not voice-slice fields.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, Mic, Copy, MicVocal, Film, Volume2, FileText, Monitor } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { WizardBadge as Badge } from '@/components/wizard-badge';
import { WizardErrorBanner } from '@/components/wizard-error-banner';
import { WizardCard as Card } from '@/components/wizard-card';
import { OptionCard } from '@/components/option-card';
import { Spinner } from '@/components/spinner';
import { humanizeError } from '../../api/http';
import { uploadAudio } from '../../api/upload';
import { useVoiceList } from '../../hooks/useVoiceList';
import { useTTSGeneration } from '../../hooks/useTTSGeneration';
import { useVoiceClone } from '../../hooks/useVoiceClone';
import { useUploadReferenceImage } from '../../hooks/useUploadReferenceImage';
import { useWizardStore } from '../../stores/wizardStore';
import { isLocalAsset, isServerAsset } from '@/wizard/normalizers';
import {
  RESOLUTION_META,
  isHostReady,
  isCompositionReady,
} from '@/wizard/schema';
import type {
  Composition,
  Host,
  LocalAsset,
  ResolutionKey,
  ServerAsset,
  Voice,
  VoiceAdvanced,
} from '@/wizard/schema';
import {
  Step3FormValuesSchema,
  formValuesToVoiceSlice,
  type Step3FormValues,
  type VoiceFormValues,
} from '@/wizard/form-mappers';
import { useFormZustandSync } from '@/hooks/wizard/useFormZustandSync';
import { useDebouncedFormSync } from '@/hooks/wizard/useDebouncedFormSync';
import { AudioPlayer } from '../shared/AudioPlayer';
import { VoicePicker } from './VoicePicker';
import { VoiceCloner } from './VoiceCloner';
import { AudioUploader } from './AudioUploader';
import { ScriptEditor, buildScript, SCRIPT_LIMIT, clampParagraphs } from './ScriptEditor';
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
  playlistId?: string | null;
}

export interface Step3AudioProps {
  state: Step3AudioState;
  update: UpdateFn;
}

// Source-mode transitions on form values. Script + advanced carry
// over where the union members agree on them; switching from upload
// to AI defaults the sliders to schema initial values (the upload
// variant has no advanced field to carry from).

function carryAdvanced(prev: VoiceFormValues): VoiceAdvanced {
  return prev.source === 'upload'
    ? { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 }
    : prev.advanced;
}

// Carrying script across upload → TTS clamps to SCRIPT_LIMIT — the
// upload-mode subtitle textarea has no per-paragraph cap, so a long
// paste must not silently ride into the TTS request.
function carryScript(prev: VoiceFormValues): { paragraphs: string[] } {
  return prev.source === 'upload'
    ? { paragraphs: clampParagraphs(prev.script.paragraphs) }
    : prev.script;
}

function toTTSForm(prev: VoiceFormValues): VoiceFormValues {
  if (prev.source === 'tts') return prev;
  return {
    source: 'tts',
    voiceId: null,
    voiceName: null,
    advanced: carryAdvanced(prev),
    script: carryScript(prev),
  };
}

function toCloneForm(prev: VoiceFormValues): VoiceFormValues {
  if (prev.source === 'clone') return prev;
  return {
    source: 'clone',
    sample: { state: 'empty' },
    advanced: carryAdvanced(prev),
    script: carryScript(prev),
  };
}

function toUploadForm(prev: VoiceFormValues): VoiceFormValues {
  if (prev.source === 'upload') return prev;
  return { source: 'upload', audio: null, script: prev.script };
}

const identity = (s: Step3FormValues): Step3FormValues => s;

export default function Step3Audio({ state, update }: Step3AudioProps) {
  const resolution: ResolutionKey = state.resolution;
  const setVoice = useWizardStore((s) => s.setVoice);

  // Each useWizardStore call subscribes to one narrow field — see
  // file header for the streaming-event regression this prevents.
  const source = useWizardStore((s) => s.voice.source);
  const script = useWizardStore((s) => s.voice.script);
  const advanced = useWizardStore((s) =>
    s.voice.source !== 'upload' ? s.voice.advanced : null,
  );
  const voiceId = useWizardStore((s) =>
    s.voice.source === 'tts' ? s.voice.voiceId : null,
  );
  const voiceName = useWizardStore((s) =>
    s.voice.source === 'tts' ? s.voice.voiceName : null,
  );
  const sample = useWizardStore((s) =>
    s.voice.source === 'clone' ? s.voice.sample : null,
  );
  const audioFromStore = useWizardStore((s) =>
    s.voice.source === 'upload' ? s.voice.audio : null,
  );
  // voice.generation is internal to the TTS pipeline; subscribed
  // separately so the audio-player render pulls fresh state without
  // blowing through the form reset path.
  const voiceGeneration = useWizardStore((s) =>
    s.voice.source !== 'upload' ? s.voice.generation : null,
  );

  const voiceList = useVoiceList();
  const tts = useTTSGeneration();
  const cloner = useVoiceClone();
  const audioUpload = useUploadReferenceImage(uploadAudio);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uploadErrorMsg, setUploadErrorMsg] = useState<string | null>(null);

  // Form-shaped projection. Memoize on the narrow field refs so
  // generation mutations don't bubble through.
  const formValues = useMemo<Step3FormValues>(() => {
    if (source === 'upload') {
      return { voice: { source: 'upload', audio: audioFromStore, script } };
    }
    if (source === 'clone') {
      return {
        voice: {
          source: 'clone',
          sample: sample!,
          advanced: advanced!,
          script,
        },
      };
    }
    return {
      voice: {
        source: 'tts',
        voiceId,
        voiceName,
        advanced: advanced!,
        script,
      },
    };
  }, [source, script, advanced, voiceId, voiceName, sample, audioFromStore]);

  const form = useForm<Step3FormValues>({
    resolver: zodResolver(Step3FormValuesSchema),
    defaultValues: formValues,
    mode: 'onBlur',
  });

  useFormZustandSync(form, formValues, identity);

  const onChange = useCallback(
    (values: Step3FormValues) => {
      setVoice((prev) => formValuesToVoiceSlice(values.voice, prev));
    },
    [setVoice],
  );
  const formSync = useDebouncedFormSync(form, onChange, 300);

  // Narrow per-field watches — broad `useWatch({name: 'voice'})` would
  // re-render Step3Audio on every keystroke in any nested field
  // (script paragraphs, advanced sliders, sample) AND emit a fresh
  // ref each time, which would re-trigger the eager-upload effect
  // even when audio didn't change.
  const watchedSource = useWatch({
    control: form.control,
    name: 'voice.source',
    defaultValue: formValues.voice.source,
  }) as VoiceFormValues['source'];
  const watchedParagraphs = useWatch({
    control: form.control,
    name: 'voice.script.paragraphs',
    defaultValue: formValues.voice.script.paragraphs,
  }) as string[];
  const watchedAudio = useWatch({
    control: form.control,
    name: 'voice.audio' as const,
  }) as ServerAsset | LocalAsset | null | undefined;
  const watchedVoiceId = useWatch({
    control: form.control,
    name: 'voice.voiceId' as const,
  }) as string | null | undefined;
  const watchedSampleState = useWatch({
    control: form.control,
    name: 'voice.sample.state' as const,
  }) as 'empty' | 'pending' | 'cloned' | undefined;

  const isAi = watchedSource !== 'upload';
  const aiSubMode: 'tts' | 'clone' = watchedSource === 'clone' ? 'clone' : 'tts';

  // Mode swaps abort in-flight TTS/clone — otherwise the result
  // lands on the new variant and shows stale audio under the wrong source.
  const abortInflight = () => {
    tts.abort();
    cloner.abort();
  };

  const switchToAi = () => {
    const cur = form.getValues('voice');
    if (cur.source === 'upload') {
      abortInflight();
      form.setValue('voice', toTTSForm(cur), {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
  };
  const switchToRawAudio = () => {
    const cur = form.getValues('voice');
    if (cur.source !== 'upload') {
      abortInflight();
      form.setValue('voice', toUploadForm(cur), {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
  };
  const switchAiSubMode = (next: 'tts' | 'clone') => {
    const cur = form.getValues('voice');
    if (cur.source === next) return;
    abortInflight();
    form.setValue(
      'voice',
      next === 'tts' ? toTTSForm(cur) : toCloneForm(cur),
      { shouldDirty: true, shouldValidate: true },
    );
  };

  // Eager upload — when upload-mode voice has a LocalAsset audio
  // pending, kick off /api/upload/audio and replace it with the
  // returned ServerAsset. The hook's epoch contract makes stale
  // results from a superseded pick land harmlessly.
  useEffect(() => {
    if (watchedSource !== 'upload') return;
    if (!watchedAudio || !isLocalAsset(watchedAudio)) return;
    const local = watchedAudio;
    setUploadErrorMsg(null);
    let alive = true;
    (async () => {
      const res = await audioUpload.upload(local.file);
      if (!alive) return;
      if (!res?.path) {
        if (audioUpload.error) setUploadErrorMsg(audioUpload.error);
        return;
      }
      const cur = form.getValues('voice');
      if (
        cur.source !== 'upload' ||
        !cur.audio ||
        !isLocalAsset(cur.audio) ||
        cur.audio.file !== local.file
      ) {
        return;
      }
      form.setValue(
        'voice',
        {
          ...cur,
          audio: {
            path: res.path as string,
            url: typeof res.url === 'string' ? res.url : undefined,
            name: local.name,
          },
        },
        { shouldDirty: true },
      );
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedSource, watchedAudio]);

  const combinedScript = buildScript(watchedParagraphs);
  const generatedSrc =
    voiceGeneration && voiceGeneration.state === 'ready'
      ? voiceGeneration.audio.url || null
      : null;
  const isGenerated =
    watchedSource !== 'upload' && voiceGeneration?.state === 'ready';
  // While TTS is generating, lock script + advanced edits — otherwise
  // a mid-flight edit lands on the resolved 'ready' state with audio
  // that doesn't match the displayed text. Mirrors the user expectation
  // that "음성 만들기 중" is a quiet phase.
  const generationLocked =
    watchedSource !== 'upload' && voiceGeneration?.state === 'generating';

  // ── Generate CTA orchestration ──────────────────────────────────
  const submit = useMemo(
    () =>
      form.handleSubmit(async ({ voice: v }) => {
        if (v.source === 'upload') return;
        setErrorMsg(null);
        try {
          // Drop the pending debounce + sync form → store. See
          // useDebouncedFormSync.cancel docblock for the clone race.
          formSync.cancel();
          setVoice((prev) => formValuesToVoiceSlice(v, prev));

          if (v.source === 'clone' && v.sample.state === 'pending') {
            const cloneResult = await cloner.clone(v.sample.asset.file);
            if (!cloneResult?.voice_id) {
              if (cloner.error) setErrorMsg(cloner.error);
              return;
            }
          }
          if (v.source === 'clone' && v.sample.state === 'empty') {
            throw new Error('클론용 샘플 음성을 올려주세요');
          }
          if (v.source === 'tts' && !v.voiceId) {
            throw new Error('목소리를 먼저 골라주세요');
          }
          const result = await tts.generate();
          if (!result) {
            if (tts.error) setErrorMsg(tts.error);
            return;
          }
        } catch (err) {
          setErrorMsg(humanizeError(err));
        }
      }),
    [form, cloner, tts, setVoice, formSync],
  );

  // audioUpload runs in upload-mode only, where the AI Generate CTA
  // doesn't render; safe to scope `generating` to the AI hooks.
  const generating = tts.isLoading || cloner.isLoading;
  const canGenerate = (() => {
    if (watchedSource === 'upload' || !combinedScript) return false;
    if (combinedScript.length > SCRIPT_LIMIT) return false;
    if (watchedSource === 'tts') return !!watchedVoiceId;
    if (watchedSource === 'clone')
      return watchedSampleState === 'cloned' || watchedSampleState === 'pending';
    return false;
  })();

  // resolution + playlistId aren't on the voice slice — keep on
  // legacy `update` prop, scope-limited to Step 3 RHF.
  const setR = (r: ResolutionKey) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update((s: any) => ({ ...s, resolution: r }));

  return (
    <FormProvider {...form}>
      <div className="step-page-split step-page-split--65-35">
        <div className="step-page-form">
          <StepHeading
            step={3}
            title="목소리와 영상"
            description="영상에 어떤 소리가 들어갈지 정하고, 화질까지 골라주세요."
            eyebrow="영상 위저드"
          />

          <div className="grid grid-cols-2 gap-3">
            <OptionCard
              active={isAi}
              icon={<Sparkles className="size-4" />}
              title="AI로 음성 만들기"
              desc="대본을 적으면 AI가 읽어줘요"
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

          {isAi && (
            <Card>
              <div className="mb-4">
                <WizardTabs
                  value={aiSubMode}
                  onValueChange={(v) => switchAiSubMode(v as 'tts' | 'clone')}
                >
                  <WizardTab value="tts" icon={<Mic className="size-3.5" />}>
                    목소리 고르기
                  </WizardTab>
                  <WizardTab value="clone" icon={<Copy className="size-3.5" />}>
                    내 목소리 복제
                  </WizardTab>
                </WizardTabs>
              </div>

              <div className="min-h-[280px]">
                {watchedSource === 'tts' && (
                  <VoicePicker
                    remoteVoices={voiceList.isLoading ? null : voiceList.voices}
                    loadError={voiceList.error}
                  />
                )}
                {watchedSource === 'clone' && <VoiceCloner />}
              </div>

              <hr className="hr" />

              <ScriptEditor disabled={generationLocked} />

              <VoiceAdvancedSettings
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
                disabled={generationLocked}
              />

              {errorMsg && <WizardErrorBanner message={errorMsg} />}

              <GenerateBar
                label={
                  isGenerated
                    ? '음성 준비 완료'
                    : '대본 입력 후 만들기 버튼을 눌러주세요'
                }
                done={!!isGenerated}
                disabled={generating || !canGenerate}
                generating={generating}
                onClick={submit}
                cta="음성 만들기"
              />

              {isGenerated && generatedSrc && <AudioPlayer src={generatedSrc} />}
            </Card>
          )}

          {watchedSource === 'upload' && (
            <Card>
              <div className="min-h-[280px]">
                <AudioUploader isUploading={audioUpload.isLoading} />
              </div>
              {uploadErrorMsg && (
                <WizardErrorBanner
                  className="mt-3"
                  message={uploadErrorMsg}
                  hint="다시 시도하려면 파일을 다시 골라주세요"
                />
              )}
              {watchedAudio && isServerAsset(watchedAudio) && (
                <div className="mt-3 flex items-center gap-2">
                  <Badge variant="success" icon="check_circle">
                    음성 준비 완료
                  </Badge>
                  <span className="text-xs text-muted-foreground">TTS를 거치지 않고 그대로 영상에 들어가요</span>
                </div>
              )}
            </Card>
          )}

          <Card title="영상 화질" subtitle="세로 영상 · 어디에 올릴지에 맞춰서 고르세요">
            <ResolutionPicker selectedKey={resolution} onSelect={setR} />
          </Card>

          <Card title="플레이리스트" subtitle="만들어진 영상을 묶어두는 폴더예요. 비워두면 미지정에 저장됩니다.">
            <PlaylistPicker
              selected={state.playlistId ?? null}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onChange={(pid) => update((s: any) => ({ ...s, playlistId: pid }))}
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
          <RenderBooth state={state} />
        </div>
      </div>
    </FormProvider>
  );
}

interface RenderBoothProps {
  state: Step3AudioState;
}

function RenderBooth({ state }: RenderBoothProps) {
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
      return `내 녹음 · ${voice.audio?.name ?? '파일'}`;
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
            {scriptLen > 0 ? `${scriptLen.toLocaleString()}자` : '대본을 적어주세요'}
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
        disabled={!allValid}
        onClick={() => navigate('/render')}
        className="mt-1 inline-flex items-center justify-center gap-2 h-12 px-5 rounded-md border-0 bg-primary text-primary-foreground text-sm font-bold tracking-tight cursor-pointer transition-colors duration-150 hover:enabled:bg-[var(--primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
      >
        <Sparkles className="size-4" strokeWidth={2.2} />
        <span>영상 만들기 시작</span>
      </button>
      {!allValid && (
        <p className="m-0 text-[11.5px] text-muted-foreground text-center tracking-tight">
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
}

function GenerateBar({ label, done, disabled, generating, onClick, cta }: GenerateBarProps) {
  return (
    <div className="flex justify-between items-center gap-3 pt-1">
      <div className={`text-xs flex items-center gap-2 ${done ? '' : 'text-muted-foreground'}`}>
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
        className="inline-flex items-center gap-2 h-10 px-5 rounded-md bg-primary text-primary-foreground text-sm-tight font-bold hover:bg-[var(--primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
      >
        {generating ? (
          <>
            <Spinner size="sm" /> 만드는 중
          </>
        ) : (
          <>
            <Sparkles className="size-4" />
            <span>{cta}</span>
          </>
        )}
      </button>
    </div>
  );
}
