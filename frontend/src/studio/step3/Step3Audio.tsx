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

import { useState } from 'react';
import Icon from '../Icon.jsx';
import { WizardBadge as Badge } from '@/components/wizard-badge';
import { WizardCard as Card } from '@/components/wizard-card';
import { OptionCard } from '@/components/option-card';
import { humanizeError } from '../api.js';
import { uploadAudio } from '../../api/upload';
import { useVoiceList } from '../../hooks/useVoiceList';
import { useTTSGeneration } from '../../hooks/useTTSGeneration';
import { useVoiceClone } from '../../hooks/useVoiceClone';
import { useUploadReferenceImage } from '../../hooks/useUploadReferenceImage';
import { AudioPlayer } from '../shared/AudioPlayer';
import { VoicePicker } from './VoicePicker';
import { VoiceCloner, type CloneSample } from './VoiceCloner';
import { AudioUploader, type UploadedAudio } from './AudioUploader';
import { ScriptEditor, buildScript } from './ScriptEditor';
import { VoiceAdvancedSettings } from './VoiceAdvancedSettings';
import { ResolutionPicker } from './ResolutionPicker';
import type { ResolutionKey } from '@/wizard/schema';
import { RESOLUTION_META } from '@/wizard/schema';
import { PlaylistPicker } from './PlaylistPicker';
import { WizardTabs, WizardTab } from '@/components/wizard-tabs';
import { Sparkles, Mic, Copy, MicVocal, Film, Volume2, FileText, Monitor } from 'lucide-react';
import { StepHeading } from '@/routes/StepHeading';
import { useNavigate } from 'react-router-dom';
import { computeValidity, isAllValid } from '@/routes/wizardValidation';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UpdateFn = (updater: (state: any) => any) => void;

export interface Step3AudioProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  update: UpdateFn;
}

export default function Step3Audio({ state, update }: Step3AudioProps) {
  const voice = state.voice as {
    source?: 'tts' | 'clone' | 'upload';
    voiceId?: string | null;
    voiceName?: string | null;
    paragraphs?: string[];
    script?: string;
    speed?: number;
    stability?: number;
    style?: number;
    similarity?: number;
    generated?: boolean;
    generatedAudioPath?: string | null;
    generatedAudioUrl?: string | null;
    uploadedAudio?: UploadedAudio | null;
    cloneSample?: CloneSample | null;
  };
  const resolution = state.resolution as ResolutionKey;

  const voiceList = useVoiceList();
  const tts = useTTSGeneration();
  const cloner = useVoiceClone();
  const audioUpload = useUploadReferenceImage(uploadAudio);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isAi = voice.source !== 'upload';
  const aiSubMode = voice.source === 'clone' ? 'clone' : 'tts';

  const setV = (patch: Partial<typeof voice>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update((s: any) => ({ ...s, voice: { ...s.voice, ...patch } }));
  const setR = (r: ResolutionKey) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update((s: any) => ({ ...s, resolution: r }));

  const switchToAi = () => {
    if (voice.source === 'upload') {
      setV({ source: 'tts', generated: false });
    }
  };
  const switchToRawAudio = () => {
    if (voice.source !== 'upload') {
      setV({ source: 'upload', generated: !!voice.uploadedAudio });
    }
  };

  const paragraphs =
    voice.paragraphs && voice.paragraphs.length > 0 ? voice.paragraphs : [''];
  const combinedScript = buildScript(paragraphs);

  const syncScript = (nextParagraphs: string[]) => {
    const combined = buildScript(nextParagraphs);
    setV({ paragraphs: nextParagraphs, script: combined });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update((s: any) => ({ ...s, script: combined }));
  };

  const generatedSrc =
    voice.generatedAudioUrl ||
    (voice.generatedAudioPath && voice.generatedAudioPath.startsWith('http')
      ? voice.generatedAudioPath
      : null);

  const estDuration = Math.round(
    combinedScript.replace(/\[breath\]/g, '').replace(/\s+/g, '').length * 0.3,
  );

  const handleGenerate = async () => {
    setErrorMsg(null);
    try {
      let voiceIdForGen = voice.voiceId;
      if (voice.source === 'clone') {
        if (!voice.cloneSample?._file && !voice.cloneSample?.voiceId) {
          throw new Error('클론용 샘플 음성을 올려주세요');
        }
        if (!voice.cloneSample?.voiceId && voice.cloneSample?._file) {
          const cloneResult = await cloner.clone(voice.cloneSample._file);
          if (cloneResult?.voice_id) {
            voiceIdForGen = cloneResult.voice_id;
            setV({
              cloneSample: { ...voice.cloneSample, voiceId: cloneResult.voice_id },
            });
          }
        } else if (voice.cloneSample?.voiceId) {
          voiceIdForGen = voice.cloneSample.voiceId;
        }
      }

      if (voiceIdForGen && voiceIdForGen !== voice.voiceId) {
        setV({ voiceId: voiceIdForGen });
      }
      const result = await tts.generate();
      if (!result) return;
      setV({
        generated: true,
        generatedAudioPath: (result.path as string) || result.audio_path || null,
        generatedAudioUrl: (result.url as string) || null,
        voiceId: voiceIdForGen ?? voice.voiceId,
      });
    } catch (err) {
      setErrorMsg(humanizeError(err));
    }
  };

  const generating = tts.isLoading || cloner.isLoading || audioUpload.isLoading;
  const canGenerate = !!voice.voiceId && !!combinedScript;

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

      {/* AI mode body */}
      {isAi && (
        <Card>
          <div className="mb-4">
            <WizardTabs
              value={aiSubMode}
              onValueChange={(v) => setV({ source: v as 'tts' | 'clone' })}
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
            {aiSubMode === 'tts' && (
              <VoicePicker
                selectedVoiceId={voice.voiceId ?? null}
                remoteVoices={voiceList.isLoading ? null : voiceList.voices}
                loadError={voiceList.error}
                onVoiceSelected={(v) => setV({ voiceId: v.id, voiceName: v.name })}
              />
            )}
            {aiSubMode === 'clone' && (
              <VoiceCloner
                cloneSample={voice.cloneSample ?? null}
                onSampleSelected={(f) =>
                  setV({
                    cloneSample: f,
                    voiceId: f ? 'cloned_' + Date.now() : null,
                    voiceName: f ? '내 목소리' : null,
                  })
                }
              />
            )}
          </div>

          <hr className="hr" />

          <ScriptEditor paragraphs={paragraphs} onParagraphsChange={syncScript} />

          <VoiceAdvancedSettings
            speed={voice.speed ?? 1}
            stability={voice.stability ?? 0.5}
            style={voice.style ?? 0.3}
            similarity={voice.similarity ?? 0.75}
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            onSpeedChange={(v) => setV({ speed: v })}
            onStabilityChange={(v) => setV({ stability: v })}
            onStyleChange={(v) => setV({ style: v })}
            onSimilarityChange={(v) => setV({ similarity: v })}
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
            label={voice.generated ? `음성 준비 완료 · ${estDuration}초` : '대본 입력 후 만들기 버튼을 누르면 ~10초 안에 음성이 만들어져요'}
            done={!!voice.generated}
            disabled={generating || !canGenerate}
            generating={generating}
            onClick={handleGenerate}
            cta="음성 만들기"
            timeHint="~10초"
          />

          {voice.generated && generatedSrc && <AudioPlayer src={generatedSrc} />}
        </Card>
      )}

      {/* Raw audio mode body */}
      {!isAi && (
        <Card>
          <div className="min-h-[280px]">
            <AudioUploader
              uploadedAudio={voice.uploadedAudio ?? null}
              subtitleScript={voice.script ?? ''}
              onAudioSelected={(f) =>
                setV({
                  uploadedAudio: f,
                  voiceId: f ? 'uploaded' : null,
                  generated: !!f,
                })
              }
              onSubtitleChange={(s) => {
                setV({ script: s });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                update((st: any) => ({ ...st, script: s }));
              }}
            />
          </div>
          {voice.uploadedAudio && (
            <div className="mt-3 flex items-center gap-2">
              <Badge variant="success" icon="check_circle">음성 준비 완료</Badge>
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
          selected={(state.playlist_id as string | null | undefined) ?? null}
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  estDuration: number;
}

function RenderBooth({ state, estDuration }: RenderBoothProps) {
  const navigate = useNavigate();
  const valid = computeValidity(state);
  const allValid = isAllValid(valid);

  const compositeUrl = state.composition?.selectedUrl as string | undefined;
  const hostUrl = state.host?.imageUrl as string | undefined;
  const heroUrl = compositeUrl || hostUrl || null;
  const heroLabel = compositeUrl
    ? '합성 결과'
    : hostUrl
      ? '쇼호스트 (합성 전)'
      : '미리보기 없음';

  const voice = (state.voice ?? {}) as {
    source?: string;
    voiceName?: string;
    voiceId?: string;
    script?: string;
    uploadedAudio?: { name?: string } | null;
  };
  const voiceLine =
    voice.source === 'upload'
      ? `내 녹음 · ${voice.uploadedAudio?.name ?? '파일'}`
      : voice.source === 'clone'
        ? `내 목소리 복제${voice.voiceName ? ` · ${voice.voiceName}` : ''}`
        : voice.voiceName
          ? `AI 음성 · ${voice.voiceName}`
          : 'AI 음성 — 목소리 미선택';
  const scriptLen = (voice.script ?? '').length;
  const resolution = state.resolution as ResolutionKey | null;
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
          <dt><Volume2 className="size-3" strokeWidth={2.2} /> 음성</dt>
          <dd>{voiceLine}</dd>
        </div>
        <div className="render-fact">
          <dt><FileText className="size-3" strokeWidth={2.2} /> 대본</dt>
          <dd>
            {scriptLen > 0
              ? `${scriptLen.toLocaleString()}자 · 약 ${estDuration}초`
              : '대본을 적어주세요'}
          </dd>
        </div>
        <div className="render-fact">
          <dt><Monitor className="size-3" strokeWidth={2.2} /> 화질</dt>
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

function resolutionLabel(key: string | undefined): string {
  return (
    ({
      '448p': '보통 화질',
      '480p': '기본 화질',
      '720p': '고화질(HD)',
      '1080p': '최고 화질(FHD)',
    } as Record<string, string>)[key ?? ''] ?? key ?? ''
  );
}

// (Local ModeCard moved to @/components/option-card.tsx — see OptionCard.)

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
          <Badge variant="success" icon="check_circle">{label}</Badge>
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
