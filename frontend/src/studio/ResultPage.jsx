// ResultPage — dedicated /result/:taskId view for finished videos.
// Fetches /api/results/{taskId} (backend manifest, or synthesized from queue
// for pre-manifest tasks) and renders the completion UI: video player,
// stats, action buttons, ProvenanceCard.
//
// Split from RenderDashboard because the dashboard had grown into two very
// different views (live progress vs frozen result) with fallback logic for
// every field. Result data now flows from a single backend endpoint, so
// there's no more "which source has this field?" gymnastics.
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Icon from './Icon.jsx';
import { Badge, Button } from './primitives.jsx';
import ProvenanceCard from './ProvenanceCard.jsx';
import QueueStatus from './QueueStatus.jsx';
import { humanizeError } from './api.js';
import { formatTaskTitle } from './taskFormat.js';

const Confetti = () => {
  const pieces = Array.from({ length: 24 });
  return (
    <div className="studio-confetti" aria-hidden="true">
      {pieces.map((_, i) => (
        <span
          key={i}
          style={{
            '--x': `${(i * 37) % 100}%`,
            '--d': `${2 + (i % 5) * 0.4}s`,
            '--delay': `${(i * 80) % 1200}ms`,
            '--hue': `${(i * 137) % 360}`,
          }}
        />
      ))}
      <style>{`
        .studio-confetti { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
        .studio-confetti span {
          position: absolute;
          left: var(--x); top: -12px;
          width: 8px; height: 12px;
          background: oklch(0.75 0.15 var(--hue));
          border-radius: 2px;
          animation: studio-confetti-fall var(--d) linear var(--delay) forwards;
          transform-origin: center;
        }
        @keyframes studio-confetti-fall {
          0% { transform: translateY(-10%) rotate(0deg); opacity: 1; }
          100% { transform: translateY(500%) rotate(720deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
};

function formatElapsed(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!bytes) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function ResultPage() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/results/${taskId}`)
      .then(async (r) => {
        if (!r.ok) {
          const msg = r.status === 404
            ? '아직 완료된 작업을 찾을 수 없어요. 잠시 후 다시 시도해 주세요.'
            : `작업 정보를 불러오지 못했어요 (${r.status})`;
          throw new Error(msg);
        }
        return r.json();
      })
      .then(d => { if (alive) { setResult(d); setError(null); } })
      .catch(err => { if (alive) setError(humanizeError(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [taskId]);

  const handleCopyShare = async () => {
    if (!result) return;
    const url = result.video_url || `/api/videos/${taskId}`;
    const link = url.startsWith('http') ? url : `${window.location.origin}${url}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* ignore */ }
  };

  const shellProps = {
    className: 'studio-root',
    'data-density': 'comfortable',
  };

  const status = result?.status;
  const isDone = status === 'completed';
  const isError = status === 'error' || status === 'cancelled';
  const videoUrl = result?.video_url || `/api/videos/${taskId}`;
  const resolutionLabel = (() => {
    const r = result?.params?.resolution_actual || result?.params?.resolution_requested;
    if (!r) return null;
    const m = /^(\d+)\s*x\s*(\d+)$/.exec(r);
    if (!m) return r;
    return `${m[2]}×${m[1]}`; // stored as HxW; display as W×H
  })();

  return (
    <div {...shellProps}>
      <div className="app-shell" data-screen-label="06 Result">
        <header className="topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <div className="brand">
              <div className="brand-mark">H</div>
              <span>HostStudio</span>
              <span className="brand-tag text-xs text-tertiary" style={{ marginLeft: 6, paddingLeft: 10, borderLeft: '1px solid var(--border)' }}>
                완성된 영상
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <QueueStatus
              onTaskClick={(id) => {
                // Clicking a queue item from /result → navigate to its own result page
                if (id) navigate(`/result/${id}`);
              }}
            />
            <Button icon="home" onClick={() => navigate('/')}>처음으로</Button>
          </div>
        </header>

        <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px 80px', background: 'var(--bg)', position: 'relative' }}>
          {isDone && <Confetti />}
          <div style={{ maxWidth: 960, margin: '0 auto', position: 'relative', zIndex: 1 }}>
            <div className="flex justify-between items-center" style={{ marginBottom: 24 }}>
              <div>
                <div className="card-eyebrow">결과</div>
                <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.015em', margin: '2px 0 0' }}>
                  {loading ? '영상 정보 불러오는 중…'
                    : isError ? '만들기에 실패했어요'
                    : isDone ? '영상이 완성됐어요!'
                    : error ? '영상 정보를 불러오지 못했어요'
                    : '처리 중이에요'}
                </h1>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button icon="plus" variant="secondary" onClick={() => navigate('/')}>새로 만들기</Button>
              </div>
            </div>

            {error && !result && (
              <div className="card" style={{ padding: 20, borderColor: 'var(--danger)' }}>
                <div style={{ color: 'var(--danger)', fontSize: 14 }}>{error}</div>
                <div style={{ marginTop: 10 }}>
                  <Button icon="arrow_left" onClick={() => navigate('/')}>처음으로 돌아가기</Button>
                </div>
              </div>
            )}

            {!error && result && (
              <div className="card" style={{ padding: 24 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 28, alignItems: 'start' }}>
                  <div style={{
                    width: 220,
                    aspectRatio: '9/16',
                    borderRadius: 12,
                    overflow: 'hidden',
                    background: '#0b0d12',
                    position: 'relative',
                    border: '1px solid var(--border)',
                    alignSelf: 'start',
                  }}>
                    {isDone ? (
                      // No autoPlay — user clicks to play. preload="metadata"
                      // so the player knows duration/dimensions without
                      // downloading bytes until they hit play.
                      <video
                        src={videoUrl}
                        controls
                        preload="metadata"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    ) : isError ? (
                      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff', textAlign: 'center', padding: 16 }}>
                        <div>
                          <Icon name="alert_circle" size={24} />
                          <div style={{ fontSize: 12, marginTop: 8, opacity: 0.9 }}>{result.error || '작업이 실패했어요'}</div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff' }}>
                        <span className="spinner" style={{ width: 24, height: 24, borderColor: 'oklch(1 0 0 / 0.2)', borderTopColor: '#fff' }} />
                      </div>
                    )}
                  </div>

                  <div className="flex-col gap-3" style={{ minWidth: 0 }}>
                    <div className="flex justify-between items-center">
                      <div>
                        <div style={{ fontSize: 16, fontWeight: 600 }}>{formatTaskTitle(taskId, result?.type || 'generate')}</div>
                        <div className="text-xs text-tertiary">
                          {resolutionLabel ? `${resolutionLabel} · 세로형` : '—'}
                        </div>
                      </div>
                      {isDone ? (
                        <Badge variant="success" icon="check_circle">완성!</Badge>
                      ) : isError ? (
                        <Badge variant="warn" icon="alert_circle">오류</Badge>
                      ) : (
                        <Badge variant="accent" icon="sparkles">처리 중</Badge>
                      )}
                    </div>

                    {isDone && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                        <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
                          <div className="card-eyebrow">걸린 시간</div>
                          <div style={{ fontSize: 16, fontWeight: 600 }} className="num mono">
                            {formatElapsed(result.generation_time_sec)}
                          </div>
                          {result.completed_at && (
                            <div className="text-xs text-tertiary" style={{ marginTop: 2 }}>
                              완료 {formatDateTime(result.completed_at)}
                            </div>
                          )}
                        </div>
                        <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
                          <div className="card-eyebrow">파일 용량</div>
                          <div style={{ fontSize: 16, fontWeight: 600 }}>{formatFileSize(result.video_bytes)}</div>
                          {resolutionLabel && (
                            <div className="text-xs text-tertiary" style={{ marginTop: 2 }}>{resolutionLabel}</div>
                          )}
                        </div>
                        <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
                          <div className="card-eyebrow">파일 형식</div>
                          <div style={{ fontSize: 16, fontWeight: 600 }}>MP4</div>
                        </div>
                      </div>
                    )}

                    {/* 2×2 action grid — download/share (do with the video) +
                        navigation (what's next). */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 'auto' }}>
                      {isDone ? (
                        <>
                          <a
                            href={`/api/videos/${taskId}?download=true`}
                            download
                            className="btn btn-primary"
                            style={{ textDecoration: 'none', justifyContent: 'center' }}
                          >
                            <Icon name="download" size={14} /> 내 컴퓨터에 저장
                          </a>
                          <Button icon={copied ? 'check' : 'link'} onClick={handleCopyShare}>
                            {copied ? '링크 복사됨' : '공유 링크 복사'}
                          </Button>
                          <Button icon="arrow_left" onClick={() => navigate('/')}>처음으로</Button>
                          <Button icon="plus" variant="primary" onClick={() => navigate('/')}>영상 하나 더 만들기</Button>
                        </>
                      ) : (
                        <>
                          <Button variant="primary" icon="download" disabled>내 컴퓨터에 저장</Button>
                          <Button icon="link" disabled>공유 링크 복사</Button>
                          <Button icon="arrow_left" onClick={() => navigate('/')}>처음으로</Button>
                          <Button icon="plus" disabled>영상 하나 더 만들기</Button>
                        </>
                      )}
                    </div>
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
