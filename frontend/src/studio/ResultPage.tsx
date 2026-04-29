/**
 * ResultPage — /result/:taskId view for finished videos.
 *
 * Fetches /api/results/{taskId} (backend manifest, or a queue-synthesized
 * fallback for pre-manifest tasks) and hands the result to focused
 * sub-components: ResultVideoCard, ResultStats, ResultActions,
 * ProvenanceCard.
 *
 * Split from RenderDashboard in an earlier phase because the dashboard
 * had grown into two very different views (live progress vs frozen
 * result) with fallback logic for every field. Result data now flows
 * from a single backend endpoint, so there's no more
 * "which source has this field?" gymnastics.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { WizardBadge as Badge } from '@/components/wizard-badge';
import { WizardButton as Button } from '@/components/wizard-button';
import ProvenanceCard from './ProvenanceCard.jsx';
import QueueStatus from './QueueStatus';
import { ProfileMenu } from '../routes/ProfileMenu';
import { fetchResult } from '../api/result';
import { humanizeError } from '../api/http';
import { retryFailedTask } from '../api/queue';
import { resolveBackendUrl } from '../lib/format';
import { useWizardStore } from '../stores/wizardStore';
import {
  RESOLUTION_META,
  type ResolutionKey,
  INITIAL_WIZARD_STATE,
  INITIAL_HOST,
  INITIAL_COMPOSITION,
  INITIAL_BACKGROUND,
  INITIAL_VOICE,
  type Host,
  type Composition,
  type Background,
  type Voice,
  type Product,
} from '../wizard/schema';
import {
  computeValidity,
  deepestReachableStep,
} from '../routes/wizardValidation';
import { ConfirmModal } from '../components/confirm-modal';
import { formatTaskTitle } from './taskFormat.js';
import { Confetti } from './shared/Confetti';
import { ResultVideoCard } from './result/ResultVideoCard';
import { ResultStats } from './result/ResultStats';
import { ResultPrimary, type ResultPrimaryStatus } from './result/ResultPrimary';
import { Brand } from '../components/brand';
import { Spinner } from '../components/spinner';

// Manifest shape — matches /api/results/{id}. Kept inline (not shared
// with ProvenanceCard) because ProvenanceCard types `result: any` to
// stay tolerant of legacy fields; we can tighten it up in a later pass.
interface ResultManifest {
  task_id?: string;
  type?: string;
  status?: 'completed' | 'error' | 'cancelled' | 'running' | 'pending';
  error?: string | null;
  completed_at?: string | null;
  generation_time_sec?: number | null;
  video_url?: string | null;
  video_bytes?: number | null;
  // D3A — non-null means this task was a retry of `retried_from`. Read
  // defensively (`?? null`) since legacy rows pre-date the field. Backend
  // pydantic schema uses extra='allow' so the value passes through even
  // before the next gen:zod / gen:types regen.
  retried_from?: string | null;
  params?: {
    resolution_actual?: string;
    resolution_requested?: string;
    [k: string]: unknown;
  } | null;
  meta?: unknown;
}

function deriveResolutionLabel(
  params: ResultManifest['params'] | null | undefined,
): string | null {
  const r = params?.resolution_actual || params?.resolution_requested;
  if (!r) return null;
  const m = /^(\d+)\s*x\s*(\d+)$/.exec(r);
  if (!m) return r;
  // Backend stores H×W (portrait canonical); display as W×H for UI.
  return `${m[2]}×${m[1]}`;
}

export default function ResultPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [result, setResult] = useState<ResultManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  // null = no modal open; otherwise the action that's pending confirmation.
  const [confirmAction, setConfirmAction] = useState<'retry' | 'edit' | null>(null);

  const doRetry = async () => {
    setConfirmAction(null);
    if (!taskId || retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await retryFailedTask(taskId);
      const newId = (res?.task_id as string | undefined) ?? null;
      if (newId) {
        navigate(`/render/${encodeURIComponent(newId)}`);
      } else {
        setRetryError('새 작업 id를 받지 못했어요');
      }
    } catch (err) {
      setRetryError(humanizeError(err));
    } finally {
      setRetrying(false);
    }
  };

  // "수정해서 다시 만들기" — atomically rebuild the entire wizard state
  // from the failed task's manifest. Single useWizardStore.setState()
  // call avoids the race the previous version had where 8 sequential
  // setters left intermediate states visible to RHF/zustand sync hooks
  // long enough to clobber the rebuild.
  const doEditAndRetry = () => {
    setConfirmAction(null);
    if (!result) return;

    const params = (result.params ?? {}) as Record<string, unknown>;
    const meta = ((result as Record<string, unknown>).meta ?? {}) as Record<string, unknown>;
    const obj = (k: string): Record<string, unknown> => {
      const v = meta[k];
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    };
    const metaHost = obj('host');
    const metaComposition = obj('composition');
    const metaBackground = obj('background');
    const metaVoice = obj('voice');
    const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const strOr = (v: unknown, d: string) => (typeof v === 'string' ? v : d);

    const imageIdFromPath = (p: string | null): string => {
      if (!p) return '';
      const base = p.split('/').pop() ?? p;
      return base.replace(/\.\w+$/, '');
    };

    // ── Host build ───────────────────────────────────────────────────
    const hostMode = strOr(metaHost.mode, 'text');
    const hostSelectedPath = str(metaHost.selectedPath);
    const hostSelectedUrl = str(metaHost.imageUrl);
    const hostSelectedSeed = num(metaHost.selectedSeed, 0);
    let nextHost: Host = INITIAL_HOST;
    if (hostSelectedPath || hostSelectedUrl) {
      const variant = {
        seed: hostSelectedSeed,
        imageId: imageIdFromPath(hostSelectedPath ?? hostSelectedUrl),
        url: hostSelectedUrl ?? '',
        key: hostSelectedPath ?? '',
      };
      nextHost = {
        input:
          hostMode === 'image'
            ? {
                kind: 'image',
                faceRef: null,
                outfitRef: null,
                outfitText: strOr(metaHost.outfitText, ''),
                extraPrompt: '',
                faceStrength: num(metaHost.faceStrength, 0.7),
                outfitStrength: num(metaHost.outfitStrength, 0.7),
              }
            : {
                kind: 'text',
                prompt: strOr(metaHost.prompt, ''),
                negativePrompt: strOr(metaHost.negativePrompt, ''),
                extraPrompt: '',
              },
        temperature: num(metaHost.temperature, 0.7),
        generation: {
          state: 'ready',
          batchId: null,
          variants: [variant],
          selected: variant,
          prevSelected: null,
        },
      };
    }

    // ── Background build ─────────────────────────────────────────────
    let nextBackground: Background = INITIAL_BACKGROUND;
    const bgSource = strOr(metaBackground.source, '');
    if (bgSource === 'preset') {
      nextBackground = { kind: 'preset', presetId: str(metaBackground.presetId) };
    } else if (bgSource === 'prompt') {
      nextBackground = { kind: 'prompt', prompt: strOr(metaBackground.prompt, '') };
    } else if (bgSource === 'url' && typeof metaBackground.imageUrl === 'string') {
      nextBackground = { kind: 'url', url: metaBackground.imageUrl as string };
    } else if (bgSource === 'upload') {
      const upPath = str(metaBackground.uploadPath);
      const upUrl = str(metaBackground.imageUrl);
      if (upPath || upUrl) {
        // Backend's /api/results enrichment populates imageUrl from
        // storage_key/path so the frontend doesn't need to construct
        // /api/files/<fname> itself (broken under separated deploy +
        // S3 cutover). Fallback to '' on a stale row — UI shows empty
        // state instead of a 404'd image.
        const fname = (upPath || upUrl || '').split('/').pop() ?? '';
        nextBackground = {
          kind: 'upload',
          asset: {
            key: upPath ?? '',
            url: upUrl ?? '',
            name: fname,
          },
        };
      }
    }

    // ── Composition build ────────────────────────────────────────────
    let nextComposition: Composition = INITIAL_COMPOSITION;
    const compPath = str(metaComposition.selectedPath);
    const compUrl = str(metaComposition.selectedUrl);
    const compSeed = num(metaComposition.selectedSeed, 0);
    if (compPath || compUrl) {
      const compVariant = {
        seed: compSeed,
        imageId: imageIdFromPath(compPath ?? compUrl),
        url: compUrl ?? '',
        key: compPath ?? '',
      };
      const shotRaw = strOr(metaComposition.shot, 'medium');
      const angleRaw = strOr(metaComposition.angle, 'eye');
      const shotEnum: Array<'closeup' | 'bust' | 'medium' | 'full'> = ['closeup', 'bust', 'medium', 'full'];
      const angleEnum: Array<'eye' | 'high' | 'low'> = ['eye', 'high', 'low'];
      const shot = shotEnum.includes(shotRaw as 'closeup' | 'bust' | 'medium' | 'full')
        ? (shotRaw as 'closeup' | 'bust' | 'medium' | 'full')
        : 'medium';
      const angle = angleEnum.includes(angleRaw as 'eye' | 'high' | 'low')
        ? (angleRaw as 'eye' | 'high' | 'low')
        : 'eye';
      nextComposition = {
        settings: {
          direction: strOr(metaComposition.direction, ''),
          shot,
          angle,
          temperature: num(metaComposition.temperature, 0.7),
          rembg: true,
        },
        generation: {
          state: 'ready',
          batchId: null,
          variants: [compVariant],
          selected: compVariant,
          prevSelected: null,
        },
      };
    }

    // ── Voice build (script + audio + voice id) ──────────────────────
    const splitScript = (text: string): string[] => {
      if (text.includes('[breath]')) {
        return text.split(/\s*\[breath\]\s*/g).map((p) => p.trim()).filter((p) => p.length > 0);
      }
      if (text.includes('\n\n')) {
        return text.split(/\n\n+/g).map((p) => p.trim()).filter((p) => p.length > 0);
      }
      return text.trim() ? [text.trim()] : [];
    };
    const scriptText =
      (typeof metaVoice.script === 'string' && metaVoice.script) ||
      (typeof params.script_text === 'string' ? params.script_text : '');
    const paragraphs = scriptText ? splitScript(scriptText) : [];
    // Audio key resolution. Pre-fix manifests stored a temp absolute path
    // in `audio_path` (the worker shadowed the storage_key with the
    // download-to-temp result). Those rows can't be rehydrated as a real
    // asset — feeding `/opt/.../temp/...wav` back into a dispatch would
    // 404. Validate the prefix and only keep storage-shaped values; anything
    // else falls through to a blank voice slice so step 3 lands in idle
    // state and the user re-clicks "음성 만들기".
    const looksLikeStorageKey = (s: unknown): s is string =>
      typeof s === 'string' && /^(outputs|uploads|examples)\//.test(s);
    const audioKey =
      (typeof params.audio_key === 'string' && params.audio_key) ||
      (looksLikeStorageKey(params.audio_path) ? params.audio_path : '');
    const audioUrl = typeof params.audio_url === 'string' ? params.audio_url : '';
    const audioName = audioKey ? (audioKey.split('/').pop() ?? '') : '';
    const audioAsset = audioKey
      ? { key: audioKey, url: audioUrl, name: audioName }
      : null;
    const voiceSource = strOr(metaVoice.source, 'tts');
    const advancedFromMeta = {
      speed: num(metaVoice.speed, 1),
      stability: num(metaVoice.stability, 0.5),
      style: num(metaVoice.style, 0.3),
      similarity: num(metaVoice.similarity, 0.75),
    };
    const scriptForVoice = {
      paragraphs: paragraphs.length > 0 ? paragraphs : [''],
    };
    let nextVoice: Voice = INITIAL_VOICE;
    if (voiceSource === 'upload') {
      nextVoice = {
        source: 'upload',
        audio: audioAsset,
        script: scriptForVoice,
      };
    } else if (voiceSource === 'clone') {
      const cloneVoiceId = str(metaVoice.voiceId);
      const cloneVoiceName = str(metaVoice.voiceName);
      const sample =
        cloneVoiceId && cloneVoiceName
          ? { state: 'cloned' as const, voiceId: cloneVoiceId, name: cloneVoiceName }
          : { state: 'empty' as const };
      nextVoice = {
        source: 'clone',
        sample,
        pendingName: '',
        advanced: advancedFromMeta,
        script: scriptForVoice,
        generation: audioAsset
          ? { state: 'ready', audio: audioAsset }
          : { state: 'idle' },
      };
    } else {
      nextVoice = {
        source: 'tts',
        voiceId: str(metaVoice.voiceId),
        voiceName: str(metaVoice.voiceName),
        advanced: advancedFromMeta,
        script: scriptForVoice,
        generation: audioAsset
          ? { state: 'ready', audio: audioAsset }
          : { state: 'idle' },
      };
    }

    // ── Products build ───────────────────────────────────────────────
    let nextProducts: Product[] = [];
    if (Array.isArray(meta.products)) {
      nextProducts = (meta.products as unknown[]).map((raw, idx): Product => {
        const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const name = typeof p.name === 'string' ? p.name : `Product ${idx + 1}`;
        const pPath = typeof p.path === 'string' ? p.path : '';
        const pUrl = typeof p.url === 'string' ? p.url : '';
        if (pPath || pUrl) {
          const fname = (pPath || pUrl).split('/').pop() ?? '';
          // Backend /api/results enrichment populates url from
          // storage_key/path, so we use whatever it sent. Empty string
          // fallback on stale rows lets the UI render the empty card
          // instead of a 404 thumbnail.
          return {
            id: `product-${idx}-${fname}`,
            name,
            source: {
              kind: 'uploaded',
              asset: {
                key: pPath || '',
                url: pUrl || '',
                name: fname || name,
              },
            },
          };
        }
        return {
          id: `product-${idx}-empty`,
          name,
          source: { kind: 'empty' },
        };
      });
    }

    // ── Resolution + image quality + playlist ────────────────────────
    // Backend stores `resolution_requested` as H×W (portrait canonical —
    // see ProvenanceCard.jsx note + app.py snap-to-16 logic). Match by
    // both digits unordered so we work whether the row was written by the
    // H×W convention or any future swap.
    let nextResolution: ResolutionKey = INITIAL_WIZARD_STATE.resolution;
    const resReq =
      typeof params.resolution_requested === 'string' ? params.resolution_requested : '';
    const m = /^(\d+)\s*x\s*(\d+)$/.exec(resReq);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const matched = (Object.keys(RESOLUTION_META) as ResolutionKey[]).find((k) => {
        const r = RESOLUTION_META[k];
        return (r.width === a && r.height === b) || (r.width === b && r.height === a);
      });
      if (matched) nextResolution = matched;
    }
    const iqRaw = str(meta.imageQuality);
    const nextImageQuality: '1K' | '2K' | '4K' =
      iqRaw === '1K' || iqRaw === '2K' || iqRaw === '4K'
        ? iqRaw
        : INITIAL_WIZARD_STATE.imageQuality;
    const nextPlaylistId =
      str(params.playlist_id) || str((result as Record<string, unknown>).playlist_id) || null;

    // ── ATOMIC swap ──────────────────────────────────────────────────
    // One setState() call replaces the whole wizard slice. wizardEpoch
    // increment forces RHF default-values memos to recompute, so step3
    // doesn't render with stale defaultValues from a prior session.
    const prevEpoch = useWizardStore.getState().wizardEpoch ?? 0;
    useWizardStore.setState({
      ...INITIAL_WIZARD_STATE,
      host: nextHost,
      products: nextProducts,
      background: nextBackground,
      composition: nextComposition,
      voice: nextVoice,
      resolution: nextResolution,
      imageQuality: nextImageQuality,
      playlistId: nextPlaylistId,
      wizardEpoch: prevEpoch + 1,
      lastSavedAt: Date.now(),
    });

    // Land on the deepest step that's already valid after hydration —
    // a complete restore drops the user straight into step 3 with the
    // host image, composite, voice, audio, script, and resolution all
    // pre-filled. They click 영상 만들기 시작 once and they're done.
    const fresh = useWizardStore.getState();
    navigate(`/step/${deepestReachableStep(computeValidity(fresh))}`);
  };

  useEffect(() => {
    if (!taskId) return;
    // AbortController + `alive` belt-and-braces: abort cancels in-flight
    // fetch (no wasted bytes); `alive` guards the setState calls from
    // running after unmount (StrictMode double-mount + race where the
    // promise resolves in the exact tick the cleanup runs).
    const controller = new AbortController();
    let alive = true;
    setLoading(true);
    fetchResult(taskId, { signal: controller.signal })
      .then((d) => {
        if (!alive) return;
        setResult(d as ResultManifest);
        setError(null);
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name === 'AbortError') return;
        if (!alive) return;
        const status = (err as { status?: number })?.status;
        const friendly =
          status === 404
            ? '아직 완료된 작업을 찾을 수 없어요. 잠시 후 다시 시도해 주세요.'
            : humanizeError(err);
        setError(friendly);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [taskId]);

  const status = result?.status;
  const isDone = status === 'completed';
  const isCancelled = status === 'cancelled';
  const isError = status === 'error';
  // Legacy combined boolean — kept for the header h1 + retry/edit modal
  // gating, which still treats both error & cancelled as "terminal-with-retry".
  const isTerminalFailure = isError || isCancelled;
  const videoUrl = resolveBackendUrl(
    result?.video_url || (taskId ? `/api/videos/${taskId}` : ''),
  );
  const resolutionLabel = deriveResolutionLabel(result?.params);

  const videoCardStatus: 'completed' | 'error' | 'processing' = isDone
    ? 'completed'
    : isTerminalFailure
      ? 'error'
      : 'processing';

  // Status for ResultPrimary. While the manifest is loading, render the
  // skeleton variant. After load: completed / error / cancelled map 1:1.
  // running/pending → "processing" (kebab-only). Unknown → processing.
  const primaryStatus: ResultPrimaryStatus = loading
    ? 'loading'
    : isDone
      ? 'completed'
      : isError
        ? 'error'
        : isCancelled
          ? 'cancelled'
          : 'processing';

  return (
    <div className="studio-root" data-density="comfortable">
      <div className="app-shell" data-screen-label="06 Result">
        <header className="topbar">
          <div className="flex items-center gap-5">
            <Brand size="md" to="/" title="홈으로" />
          </div>
          <div className="topbar-right">
            <QueueStatus />
            <Button icon="video" size="sm" onClick={() => navigate('/results')}>
              내 영상
            </Button>
            <ProfileMenu />
          </div>
        </header>

        <div className="relative flex-1 overflow-y-auto lg:overflow-hidden lg:flex lg:flex-col px-8 pt-5 pb-5 bg-background">
          {isDone && <Confetti />}
          <div className="relative z-[1] max-w-[1100px] mx-auto w-full lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
            <div className="mb-6">
              <div className="text-sm-tight text-ink-3 font-medium">결과</div>
              <h1 className="inline-flex items-center gap-2.5 text-[22px] font-bold tracking-tighter leading-[1.25] mt-1 mb-0">
                {loading && <Spinner size="md" />}
                {loading
                  ? '영상 정보 불러오는 중…'
                  : isError
                    ? '만들기에 실패했어요'
                    : isCancelled
                      ? '취소된 작업이에요'
                      : isDone
                        ? '영상이 완성됐어요!'
                        : error
                          ? '영상 정보를 불러오지 못했어요'
                          : '처리 중이에요'}
              </h1>
            </div>

            {/* ConfirmModals stay at the page level — opened by the
                ResultPrimary callbacks below, so the modals don't have
                to live inside the (potentially unmounted) component. */}
            <ConfirmModal
              open={confirmAction === 'retry'}
              title="이 작업을 다시 시도할까요?"
              description="같은 입력으로 새 작업을 큐에 넣어요. 같은 환경에서 같은 이유로 또 실패할 수 있어요."
              confirmLabel="재시도"
              onConfirm={doRetry}
              onCancel={() => setConfirmAction(null)}
              busy={retrying}
            />
            <ConfirmModal
              open={confirmAction === 'edit'}
              title="입력을 수정해서 다시 만들까요?"
              description={
                <>
                  <p className="m-0 leading-relaxed">
                    이 작업의 <b>대본</b>과 <b>화질</b> 설정을 마법사에 채우고
                    <br />
                    <b>1단계</b>부터 다시 시작해요.
                  </p>
                  <p className="mt-2 m-0 leading-relaxed text-muted-foreground">
                    지금까지 입력하던 다른 마법사 작업이 있다면 사라져요.
                  </p>
                </>
              }
              confirmLabel="시작하기"
              onConfirm={doEditAndRetry}
              onCancel={() => setConfirmAction(null)}
            />

            {error && !result && (
              <div className="surface-base p-5 border-destructive">
                <div className="text-destructive text-sm">{error}</div>
                <div className="mt-2.5">
                  <Button icon="arrow_left" onClick={() => navigate('/')}>
                    처음으로 돌아가기
                  </Button>
                </div>
              </div>
            )}

            {retryError && (
              <div className="mb-3 px-3 py-2 bg-destructive-soft text-destructive rounded-md text-xs">
                {retryError}
              </div>
            )}

            {!error && result && taskId && (
              <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)] lg:flex-1 lg:min-h-0">
                {/* Video column: card → title/badge → stats. Card grows
                    to consume slack height (aspect-bound), title + stats
                    natural height. lg:overflow-hidden to forbid scroll. */}
                <div className="surface-base p-5 flex flex-col gap-4 lg:min-h-0 lg:overflow-hidden">
                  <div className="flex justify-center lg:flex-1 lg:min-h-0">
                    <ResultVideoCard
                      status={videoCardStatus}
                      videoUrl={videoUrl}
                      errorMessage={result.error ?? null}
                      className="w-[280px] lg:w-auto lg:h-full lg:max-w-full lg:self-stretch"
                    />
                  </div>

                  <div className="flex justify-between items-center gap-3">
                    <div className="min-w-0">
                      <div className="text-base font-semibold truncate">
                        {formatTaskTitle(taskId, result.type || 'generate')}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {resolutionLabel ? `${resolutionLabel} · 세로형` : '—'}
                      </div>
                    </div>
                    {isDone ? (
                      <Badge variant="success" icon="check_circle">
                        완성!
                      </Badge>
                    ) : isError ? (
                      <Badge variant="warn" icon="alert_circle">
                        오류
                      </Badge>
                    ) : isCancelled ? (
                      // Match the /results grid card: pill-muted "취소".
                      <span className="pill-muted">취소</span>
                    ) : (
                      <Badge variant="accent" icon="sparkles">
                        처리 중
                      </Badge>
                    )}
                  </div>

                  {isDone && (
                    <ResultStats
                      elapsedSec={result.generation_time_sec}
                      completedAt={result.completed_at}
                      fileSizeBytes={result.video_bytes}
                      resolutionLabel={resolutionLabel}
                    />
                  )}
                </div>

                {/* Provenance column — primary actions on top so 저장/케밥
                    is visible above the fold; ProvenanceCard fills below. */}
                <div className="flex flex-col gap-4 lg:min-h-0">
                  <ResultPrimary
                    status={primaryStatus}
                    taskId={taskId}
                    retriedFrom={result.retried_from ?? null}
                    onEdit={() => setConfirmAction('edit')}
                    onRetry={() => setConfirmAction('retry')}
                    onNew={() => navigate('/')}
                  />
                  <div className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
                    <ProvenanceCard result={result} />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
