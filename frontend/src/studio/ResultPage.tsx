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
import { RESOLUTION_META, type ResolutionKey } from '../wizard/schema';
import { ConfirmModal } from '../components/confirm-modal';
import { schemas } from '../api/schemas-generated';
import { formatTaskTitle } from './taskFormat.js';
import { Confetti } from './shared/Confetti';
import { ResultVideoCard } from './result/ResultVideoCard';
import { ResultStats } from './result/ResultStats';
import { ResultActions } from './result/ResultActions';
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
  timestamp?: string;
  script_text?: string;
  host_image?: string;
  generation_time?: number;
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

  // "수정해서 다시 만들기" — hydrate the wizard with the params we can
  // safely restore (script text, resolution) and drop the user back at
  // step 1 to re-pick host + voice. We can't restore host/voice/composition
  // directly because their lifecycle (selected/url/seed/etc.) is wider
  // than what the manifest carries — better to make the user re-confirm
  // than fake a half-valid generation.
  const doEditAndRetry = () => {
    setConfirmAction(null);
    if (!result) return;
    const params = (result.params ?? {}) as Record<string, unknown>;
    const meta = ((result as Record<string, unknown>).meta ?? {}) as Record<string, unknown>;
    const metaVoice = (meta.voice && typeof meta.voice === 'object'
      ? (meta.voice as Record<string, unknown>)
      : {}) as Record<string, unknown>;

    // backend's params.script_text is sometimes empty — meta.voice.script
    // (joined with ' [breath] ' for tts/clone, '\n\n' for upload) is the
    // reliable source. Try meta first, params second.
    const scriptText =
      (typeof metaVoice.script === 'string' && metaVoice.script) ||
      (typeof params.script_text === 'string' ? params.script_text : '');
    const resReq =
      typeof params.resolution_requested === 'string' ? params.resolution_requested : '';

    const store = useWizardStore.getState();
    store.reset();

    // Re-split the script back into paragraphs. Tries the tts/clone
    // separator (`[breath]`) first, falls back to upload-mode (`\n\n`),
    // then a single-paragraph entry for legacy rows.
    const splitScript = (text: string): string[] => {
      if (text.includes('[breath]')) {
        return text
          .split(/\s*\[breath\]\s*/g)
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
      }
      if (text.includes('\n\n')) {
        return text
          .split(/\n\n+/g)
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
      }
      return text.trim() ? [text.trim()] : [];
    };
    const paragraphs = scriptText ? splitScript(scriptText) : [];

    // Hydrate the voice slice when meta says it was a tts run — voice
    // selection + advanced sliders + script all carry over so the user
    // doesn't have to re-pick at step 3. clone/upload have lifecycle we
    // can't fake (sample upload, audio file path) — script alone for those.
    const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    if (metaVoice.source === 'tts' && typeof metaVoice.voiceId === 'string') {
      store.setVoice(() => ({
        source: 'tts',
        voiceId: metaVoice.voiceId as string,
        voiceName: str(metaVoice.voiceName),
        advanced: {
          speed: num(metaVoice.speed, 1),
          stability: num(metaVoice.stability, 0.5),
          style: num(metaVoice.style, 0.3),
          similarity: num(metaVoice.similarity, 0.75),
        },
        script: { paragraphs: paragraphs.length > 0 ? paragraphs : [''] },
        generation: { state: 'idle' },
      }));
    } else if (paragraphs.length > 0) {
      // Non-tts source — at least restore the script so the user only
      // has to re-pick the voice, not retype the whole thing.
      store.setVoice((prev) => ({
        ...prev,
        script: { paragraphs },
      }));
    }

    // Restore the resolution preset by reverse-looking-up RESOLUTION_META.
    // Backend stores 'WxH' (portrait canonical, e.g. '1080x1920').
    const m = /^(\d+)\s*x\s*(\d+)$/.exec(resReq);
    if (m) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      const matched = (Object.keys(RESOLUTION_META) as ResolutionKey[]).find(
        (k) => RESOLUTION_META[k].width === w && RESOLUTION_META[k].height === h,
      );
      if (matched) store.setResolution(matched);
    }

    navigate('/step/1');
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
  const isError = status === 'error' || status === 'cancelled';
  const videoUrl = result?.video_url || (taskId ? `/api/videos/${taskId}` : '');
  const resolutionLabel = deriveResolutionLabel(result?.params);

  const videoCardStatus: 'completed' | 'error' | 'processing' = isDone
    ? 'completed'
    : isError
      ? 'error'
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
            <span className="meta">자동 저장됨</span>
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
            <div className="flex justify-between items-center mb-6">
              <div>
                <div className="text-sm-tight text-ink-3 font-medium">결과</div>
                <h1 className="inline-flex items-center gap-2.5 text-[22px] font-bold tracking-tighter leading-[1.25] mt-1 mb-0">
                  {loading && <Spinner size="md" />}
                  {loading
                    ? '영상 정보 불러오는 중…'
                    : isError
                      ? '만들기에 실패했어요'
                      : isDone
                        ? '영상이 완성됐어요!'
                        : error
                          ? '영상 정보를 불러오지 못했어요'
                          : '처리 중이에요'}
                </h1>
              </div>
              <div className="flex gap-2">
                {isError && (
                  <>
                    <Button
                      icon="refresh"
                      variant="secondary"
                      onClick={() => setConfirmAction('retry')}
                      disabled={retrying}
                      title="같은 입력으로 그대로 다시 시도"
                    >
                      {retrying ? '재시도 중…' : '재시도'}
                    </Button>
                    <Button
                      icon="settings"
                      variant="secondary"
                      onClick={() => setConfirmAction('edit')}
                      title="이 작업의 입력값을 마법사에 채우고 처음부터 다시"
                    >
                      수정해서 다시 만들기
                    </Button>
                  </>
                )}
                <Button icon="plus" variant="secondary" onClick={() => navigate('/')}>
                  새로 만들기
                </Button>
              </div>

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
            </div>

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

                    <ResultActions
                      isDone={isDone}
                      taskId={taskId}
                      copied={copied}
                      onCopyShare={handleCopyShare}
                      onGoHome={() => navigate('/')}
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
