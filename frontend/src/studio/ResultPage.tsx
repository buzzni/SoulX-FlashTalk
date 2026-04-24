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
import { Badge, Button } from './primitives.jsx';
import ProvenanceCard from './ProvenanceCard.jsx';
import QueueStatus from './QueueStatus';
import { fetchResult } from '../api/result';
import { humanizeError } from '../api/http';
import { formatTaskTitle } from './taskFormat.js';
import { Confetti } from './shared/Confetti';
import { ResultVideoCard } from './result/ResultVideoCard';
import { ResultStats } from './result/ResultStats';
import { ResultActions } from './result/ResultActions';

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

export default function ResultPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [result, setResult] = useState<ResultManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <div className="brand">
              <div className="brand-mark">H</div>
              <span>HostStudio</span>
              <span
                className="brand-tag text-xs text-tertiary"
                style={{
                  marginLeft: 6,
                  paddingLeft: 10,
                  borderLeft: '1px solid var(--border)',
                }}
              >
                완성된 영상
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <QueueStatus />
            <Button icon="home" onClick={() => navigate('/')}>
              처음으로
            </Button>
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
          <div style={{ maxWidth: 960, margin: '0 auto', position: 'relative', zIndex: 1 }}>
            <div className="flex justify-between items-center" style={{ marginBottom: 24 }}>
              <div>
                <div className="card-eyebrow">결과</div>
                <h1
                  style={{
                    fontSize: 24,
                    fontWeight: 600,
                    letterSpacing: '-0.015em',
                    margin: '2px 0 0',
                  }}
                >
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
              <div className="card" style={{ padding: 20, borderColor: 'var(--danger)' }}>
                <div style={{ color: 'var(--danger)', fontSize: 14 }}>{error}</div>
                <div style={{ marginTop: 10 }}>
                  <Button icon="arrow_left" onClick={() => navigate('/')}>
                    처음으로 돌아가기
                  </Button>
                </div>
              </div>
            )}

            {!error && result && taskId && (
              <div className="card" style={{ padding: 24 }}>
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

            {result && <ProvenanceCard result={result} />}
          </div>
        </div>
      </div>
    </div>
  );
}
