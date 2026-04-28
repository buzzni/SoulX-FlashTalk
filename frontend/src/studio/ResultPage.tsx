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
import { useParams, useNavigate, Link } from 'react-router-dom';
import { WizardBadge as Badge } from '@/components/wizard-badge';
import { WizardButton as Button } from '@/components/wizard-button';
import ProvenanceCard from './ProvenanceCard.jsx';
import QueueStatus from './QueueStatus';
import { ProfileMenu } from '../routes/ProfileMenu';
import { fetchResult } from '../api/result';
import { fetchJSON, humanizeError } from '../api/http';
import { retryFailedTask } from '../api/queue';
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
import { schemas } from '../api/schemas-generated';
import { formatTaskTitle } from './taskFormat.js';
import { Confetti } from './shared/Confetti';
import { ResultVideoCard } from './result/ResultVideoCard';
import { ResultStats } from './result/ResultStats';
import { ResultPrimary, type ResultPrimaryStatus } from './result/ResultPrimary';
import { Brand } from '../components/brand';
import { Spinner } from '../components/spinner';
import { videoTitle, formatRelativeDate, formatDuration } from '../lib/format';

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

interface RecentItem {
  task_id: string;
  type?: 'generate' | 'conversation' | null;
  timestamp?: string | null;
  generation_time?: number | null;
  video_url?: string;
}

export default function ResultPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [result, setResult] = useState<ResultManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [recent, setRecent] = useState<RecentItem[] | null>(null);
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
        path: hostSelectedPath ?? '',
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
        const fname = ((upPath ?? upUrl) ?? '').split('/').pop() ?? '';
        nextBackground = {
          kind: 'upload',
          asset: {
            path: upPath ?? '',
            url: upUrl ?? (upPath ? `/api/files/${fname}` : ''),
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
        path: compPath ?? '',
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
    const audioPath = typeof params.audio_path === 'string' ? params.audio_path : '';
    const audioName = audioPath ? (audioPath.split('/').pop() ?? '') : '';
    const audioAsset = audioPath
      ? { path: audioPath, url: `/api/files/${audioName}`, name: audioName }
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
          return {
            id: `product-${idx}-${fname}`,
            name,
            source: {
              kind: 'uploaded',
              asset: {
                path: pPath || '',
                url: pUrl || (pPath ? `/api/files/${fname}` : ''),
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
    let nextResolution: ResolutionKey = INITIAL_WIZARD_STATE.resolution;
    const resReq =
      typeof params.resolution_requested === 'string' ? params.resolution_requested : '';
    const m = /^(\d+)\s*x\s*(\d+)$/.exec(resReq);
    if (m) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      const matched = (Object.keys(RESOLUTION_META) as ResolutionKey[]).find(
        (k) => RESOLUTION_META[k].width === w && RESOLUTION_META[k].height === h,
      );
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

  // Fetch a few recent results to show as "다른 영상 둘러보기" sidebar.
  useEffect(() => {
    const ctl = new AbortController();
    fetchJSON('/api/history?limit=6', {
      signal: ctl.signal,
      label: '최근 영상',
      schema: schemas.HistoryResponse,
    })
      .then((r) => {
        const videos = (r.videos ?? []) as RecentItem[];
        setRecent(videos.filter((v) => v.task_id !== taskId).slice(0, 5));
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [taskId]);

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
  const videoUrl = result?.video_url || (taskId ? `/api/videos/${taskId}` : '');
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

  const handleCopyShare = async () => {
    if (!taskId) return;
    const url = result?.video_url || `/api/videos/${taskId}`;
    const link = url.startsWith('http') ? url : `${window.location.origin}${url}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore clipboard failures */
    }
  };


  return (
    <div className="studio-root" data-density="comfortable">
      <div className="app-shell" data-screen-label="06 Result">
        <header className="topbar">
          <div className="flex items-center gap-5">
            <Brand size="md" to="/" title="홈으로" />
          </div>
          <div className="topbar-right">
            <QueueStatus />
            <Button icon="home" size="sm" onClick={() => navigate('/')}>
              처음으로
            </Button>
            <ProfileMenu />
          </div>
        </header>

        <div className="relative flex-1 overflow-y-auto px-8 pt-7 pb-20 bg-background">
          {isDone && <Confetti />}
          <div className="relative z-[1] max-w-[1100px] mx-auto">
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
                  <p className="mt-2 m-0 leading-relaxed text-tertiary">
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
              <div className="surface-base p-6">
                <div className="grid grid-cols-[220px_1fr] gap-7 items-start">
                  <ResultVideoCard
                    status={videoCardStatus}
                    videoUrl={videoUrl}
                    errorMessage={result.error ?? null}
                  />

                  <div className="flex-col gap-3 min-w-0">
                    <div className="flex justify-between items-center">
                      <div>
                        <div className="text-base font-semibold">
                          {formatTaskTitle(taskId, result.type || 'generate')}
                        </div>
                        <div className="text-xs text-tertiary">
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

                    <ResultPrimary
                      status={primaryStatus}
                      taskId={taskId}
                      retriedFrom={result.retried_from ?? null}
                      copied={copied}
                      onCopyShare={handleCopyShare}
                      onEdit={() => setConfirmAction('edit')}
                      onRetry={() => setConfirmAction('retry')}
                      onNew={() => navigate('/')}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 2-column body: main details on left, related sidebar on right */}
            {!error && result && taskId && recent && recent.length > 0 && (
              <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-5 mt-4 items-start">
                <div>
                  {result && <ProvenanceCard result={result} />}
                </div>
                <RelatedRail items={recent} />
              </div>
            )}
            {!error && result && taskId && (!recent || recent.length === 0) && (
              <>{result && <ProvenanceCard result={result} />}</>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RelatedRail({ items }: { items: RecentItem[] }) {
  return (
    <aside className="surface-base p-3.5 sticky top-4">
      <div className="text-2xs font-bold text-ink-3 uppercase tracking-widest mb-2.5">
        다른 영상 둘러보기
      </div>
      <div className="flex flex-col gap-2">
        {items.map((it) => (
          <Link
            key={it.task_id}
            to={`/result/${it.task_id}`}
            className="grid grid-cols-[64px_1fr] gap-2.5 p-2 rounded-md no-underline text-foreground hover:bg-secondary transition-colors"
          >
            <div className="w-16 h-12 rounded overflow-hidden bg-foreground">
              <video
                src={it.video_url || `/api/videos/${it.task_id}`}
                preload="metadata"
                muted
                playsInline
                className="block w-full h-full object-cover"
              />
            </div>
            <div className="min-w-0 flex flex-col justify-center">
              <div className="text-xs font-semibold tracking-tight line-clamp-2 leading-tight">
                {videoTitle(it)}
              </div>
              <div className="text-2xs text-muted-foreground tabular-nums mt-0.5">
                {formatRelativeDate(it.timestamp)}
                {it.generation_time && it.generation_time < 600 && ` · ${formatDuration(it.generation_time)}`}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </aside>
  );
}
