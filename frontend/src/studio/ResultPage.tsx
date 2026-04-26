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
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { WizardBadge as Badge } from '@/components/wizard-badge';
import { WizardButton as Button } from '@/components/wizard-button';
import ProvenanceCard from './ProvenanceCard.jsx';
import QueueStatus from './QueueStatus';
import { ProfileMenu } from '../routes/ProfileMenu';
import { fetchResult } from '../api/result';
import { fetchJSON, humanizeError } from '../api/http';
import { formatTaskTitle } from './taskFormat.js';
import { Confetti } from './shared/Confetti';
import { ResultVideoCard } from './result/ResultVideoCard';
import { ResultStats } from './result/ResultStats';
import { ResultActions } from './result/ResultActions';
import { getUser, subscribe } from '../stores/authStore';
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

  // Fetch a few recent results to show as "다른 영상 둘러보기" sidebar.
  useEffect(() => {
    const ctl = new AbortController();
    fetchJSON<{ videos: RecentItem[] }>('/api/history?limit=6', {
      signal: ctl.signal,
      label: '최근 영상',
    })
      .then((r) => setRecent(r.videos.filter((v) => v.task_id !== taskId).slice(0, 5)))
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

  const user = useSyncExternalStore(subscribe, getUser, getUser);
  const display = user?.display_name || user?.user_id || 'F';
  const initial = (display[0] || 'F').toUpperCase();

  return (
    <div className="studio-root" data-density="comfortable">
      <div className="app-shell" data-screen-label="06 Result">
        <header className="topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <Link to="/" className="brand" style={{ textDecoration: 'none', color: 'inherit' }} title="홈으로">
              <div className="brand-mark" aria-hidden>{initial}</div>
              <span>FlashTalk</span>
              <span className="brand-tag">완성된 영상</span>
            </Link>
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

        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '28px 32px 80px',
            background: 'var(--bg)',
            position: 'relative',
          }}
        >
          {isDone && <Confetti />}
          <div style={{ maxWidth: 1100, margin: '0 auto', position: 'relative', zIndex: 1 }}>
            <div className="flex justify-between items-center" style={{ marginBottom: 24 }}>
              <div>
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)', fontWeight: 500 }}>결과</div>
                <h1
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    letterSpacing: '-0.024em',
                    lineHeight: 1.25,
                    margin: '4px 0 0',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
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
              <div style={{ display: 'flex', gap: 8 }}>
                <Button icon="plus" variant="secondary" onClick={() => navigate('/')}>
                  새로 만들기
                </Button>
              </div>
            </div>

            {error && !result && (
              <div className="surface-base p-5" style={{ padding: 20, borderColor: 'var(--danger)' }}>
                <div style={{ color: 'var(--danger)', fontSize: 14 }}>{error}</div>
                <div style={{ marginTop: 10 }}>
                  <Button icon="arrow_left" onClick={() => navigate('/')}>
                    처음으로 돌아가기
                  </Button>
                </div>
              </div>
            )}

            {!error && result && taskId && (
              <div className="surface-base p-5" style={{ padding: 24 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '220px 1fr',
                    gap: 28,
                    alignItems: 'start',
                  }}
                >
                  <ResultVideoCard
                    status={videoCardStatus}
                    videoUrl={videoUrl}
                    errorMessage={result.error ?? null}
                  />

                  <div className="flex-col gap-3" style={{ minWidth: 0 }}>
                    <div className="flex justify-between items-center">
                      <div>
                        <div style={{ fontSize: 16, fontWeight: 600 }}>
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
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) 280px',
                  gap: 20,
                  marginTop: 16,
                  alignItems: 'start',
                }}
              >
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
    <aside
      className="surface-base"
      style={{ padding: 14, position: 'sticky', top: 16 }}
    >
      <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.06, marginBottom: 10 }}>
        다른 영상 둘러보기
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
              <div className="text-[12.5px] font-semibold tracking-[-0.012em] line-clamp-2 leading-tight">
                {videoTitle(it)}
              </div>
              <div className="text-[10.5px] text-muted-foreground tabular-nums mt-0.5">
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
