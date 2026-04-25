/**
 * Step3Audio — wizard Step 3 container.
 *
 * Post-Phase-4c: orchestrates 6 sub-components + the shared
 * AudioPlayer. Generation uses the Phase 3 hooks
 * (useVoiceList / useVoiceClone / useTTSGeneration) with
 * AbortController + epoch-guarded state. Upload-source flow
 * (user's own audio) uses useUploadReferenceImage pointed at
 * uploadAudio.
 *
 * Kept byte-compatible with the legacy `{state, update}` prop
 * interface — Phase 5 drops props when steps move to URL-scoped
 * routes.
 */

import { useState } from 'react';
import Icon from '../Icon.jsx';
import { Badge, Button, Card } from '../primitives.jsx';
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
import { ResolutionPicker, type ResolutionPreset } from './ResolutionPicker';
import { PlaylistPicker } from './PlaylistPicker';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UpdateFn = (updater: (state: any) => any) => void;

export interface Step3AudioProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  update: UpdateFn;
}

const TABS = [
  { id: 'tts' as const, label: '목소리 고르기', icon: 'mic' },
  { id: 'clone' as const, label: '내 목소리 복제', icon: 'copy' },
  { id: 'upload' as const, label: '녹음 파일 업로드', icon: 'upload' },
];

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
  const resolution = state.resolution as { key: string };

  const voiceList = useVoiceList();
  const tts = useTTSGeneration();
  const cloner = useVoiceClone();
  const audioUpload = useUploadReferenceImage(uploadAudio);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const setV = (patch: Partial<typeof voice>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update((s: any) => ({ ...s, voice: { ...s.voice, ...patch } }));
  const setR = (r: ResolutionPreset) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update((s: any) => ({ ...s, resolution: r }));

  // Paragraphs — ensure there's always at least one so ScriptEditor
  // has something to render.
  const paragraphs =
    voice.paragraphs && voice.paragraphs.length > 0 ? voice.paragraphs : [''];
  const combinedScript = buildScript(paragraphs);

  const syncScript = (nextParagraphs: string[]) => {
    const combined = buildScript(nextParagraphs);
    setV({ paragraphs: nextParagraphs, script: combined });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update((s: any) => ({ ...s, script: combined }));
  };

  // Prefer the relative URL the backend hands back — it routes
  // through the Vite proxy so we don't have to hardcode :8001.
  const generatedSrc =
    voice.generatedAudioUrl ||
    (voice.generatedAudioPath && voice.generatedAudioPath.startsWith('http')
      ? voice.generatedAudioPath
      : null);

  // Estimated TTS duration for the success badge (Korean ≈ 0.3s per non-
  // whitespace char — rough rule of thumb matching ElevenLabs output).
  const estDuration = Math.round(
    combinedScript.replace(/\[breath\]/g, '').replace(/\s+/g, '').length * 0.3,
  );

  const handleGenerate = async () => {
    setErrorMsg(null);
    try {
      if (voice.source === 'upload') {
        if (!voice.uploadedAudio?._file && !voice.uploadedAudio?.path) {
          throw new Error('음성 파일을 업로드해주세요');
        }
        if (voice.uploadedAudio._file && !voice.uploadedAudio.path) {
          const r = await audioUpload.upload(voice.uploadedAudio._file);
          if (r) {
            setV({
              uploadedAudio: { ...voice.uploadedAudio, path: r.path ?? null },
              generated: true,
            });
          }
        } else {
          setV({ generated: true });
        }
        return;
      }

      // Clone flow: upload sample → get voice_id → TTS generate.
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

      // Stash the resolved voiceId into the store so useTTSGeneration
      // (which reads store state at call time) picks it up.
      if (voiceIdForGen && voiceIdForGen !== voice.voiceId) {
        setV({ voiceId: voiceIdForGen });
      }
      const result = await tts.generate();
      if (!result) return; // hook handled error/abort
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

  return (
    <div className="step-page">
      <div className="step-heading">
        <h1>3단계 · 목소리와 영상</h1>
        <p>읽을 목소리와 대본을 정하고, 영상 화질까지 골라주세요.</p>
      </div>

      <Card>
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab ${voice.source === t.id ? 'on' : ''}`}
              onClick={() => setV({ source: t.id })}
            >
              <Icon name={t.icon} size={12} style={{ marginRight: 5, verticalAlign: '-2px' }} />
              {t.label}
            </button>
          ))}
        </div>

        {(voice.source === 'tts' || voice.source === 'clone') && (
          <>
            {voice.source === 'tts' && (
              <VoicePicker
                selectedVoiceId={voice.voiceId ?? null}
                remoteVoices={voiceList.isLoading ? null : voiceList.voices}
                loadError={voiceList.error}
                onVoiceSelected={(v) => setV({ voiceId: v.id, voiceName: v.name })}
              />
            )}

            {voice.source === 'clone' && (
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
                  marginTop: 10,
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

            <div className="flex justify-between items-center mt-3">
              <div className="text-xs text-tertiary">
                {voice.generated ? (
                  <Badge variant="success" icon="check_circle">
                    음성 준비 완료 · {estDuration}초
                  </Badge>
                ) : (
                  '목소리를 고르고 대본을 적은 뒤 만들기 버튼을 눌러주세요'
                )}
              </div>
              <Button
                variant="primary"
                icon={generating ? undefined : 'sparkles'}
                onClick={handleGenerate}
                disabled={generating || !voice.voiceId || !combinedScript}
              >
                {generating ? (
                  <>
                    <span className="spinner" /> 만드는 중
                  </>
                ) : (
                  '음성 만들기'
                )}
              </Button>
            </div>
            {voice.generated && generatedSrc && <AudioPlayer src={generatedSrc} />}
          </>
        )}

        {voice.source === 'upload' && (
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
        )}
      </Card>

      <Card title="영상 화질" subtitle="세로 영상 · 어디에 올릴지에 맞춰서 고르세요">
        <ResolutionPicker selectedKey={resolution.key} onSelect={setR} />
      </Card>

      <Card title="플레이리스트" subtitle="만들어진 영상을 묶어두는 폴더예요. 비워두면 미지정에 저장됩니다.">
        <PlaylistPicker
          selected={(state.playlist_id as string | null | undefined) ?? null}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onChange={(pid) => update((s: any) => ({ ...s, playlist_id: pid }))}
        />
      </Card>
    </div>
  );
}
