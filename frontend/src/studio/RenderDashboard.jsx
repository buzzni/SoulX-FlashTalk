// Render dashboard — live progress view for a video-generation job.
// Dispatches /api/generate, subscribes to /api/progress/{task_id} SSE, polls
// /api/queue for queue position, and shows per-stage progress. On completion
// it redirects to /result/:taskId — the completion UI and "이렇게 만들었어요"
// panel both live on ResultPage.jsx now, reading from the backend manifest.
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon.jsx';
import { Badge, Button } from './primitives.jsx';
import { generateVideo, getVideoMeta, humanizeError, subscribeProgress } from './api.js';
import { useQueueEntry, useQueuePosition } from '../stores/queueStore';
import RenderHistory from './RenderHistory.jsx';
import { formatTaskTitle } from './taskFormat.js';

// The worker (app.py::update_task) emits more granular stage keys than we
// show in the UI. We group them into 5 user-visible buckets so the checklist
// advances cleanly. Backend keys → UI bucket:
//   queued → queued
//   compositing_bg → composite
//   loading, preparing → voice (model + data setup before animation)
//   generating → render (the bulk of inference)
//   saving, compositing → encode
// Anything we don't recognize (older worker builds, future additions) falls
// back to a progress-% heuristic below.
const STAGES = [
  { key: 'queued',    label: '대기열 등록 중',          backendKeys: ['queued'] },
  { key: 'composite', label: '제품·배경 합치는 중',      backendKeys: ['compositing_bg'] },
  { key: 'voice',     label: '목소리와 입 모양 맞추는 중', backendKeys: ['loading', 'preparing'] },
  { key: 'render',    label: '쇼호스트 움직임 만드는 중',  backendKeys: ['generating'] },
  { key: 'encode',    label: '영상 파일로 만드는 중',    backendKeys: ['saving', 'compositing'] },
];

const resolveStageIdx = (backendStage, progressPct) => {
  if (backendStage) {
    const idx = STAGES.findIndex(s => s.backendKeys.includes(backendStage));
    if (idx >= 0) return idx;
  }
  // Progress-based fallback (matches the progress thresholds the worker emits)
  const p = Number.isFinite(progressPct) ? progressPct : 0;
  if (p >= 90) return 4;
  if (p >= 28) return 3;
  if (p >= 10) return 2;
  if (p >= 2) return 1;
  return 0;
};

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // Year included so users browsing older history know whether they're
  // looking at today's run or last week's. ko-KR with `year: 'numeric'`
  // produces e.g. "2026. 04. 23. 14:22:30" — too noisy. Build the string
  // manually for "2026-04-23 14:22:30" which reads cleaner inline.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const Confetti = () => {
  // CSS-only celebration: 24 paper squares falling with hue variance.
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
        .studio-confetti {
          position: absolute; inset: 0; pointer-events: none; overflow: hidden;
        }
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

const RenderDashboard = ({ state, attachToTaskId = null, onBack, onReset }) => {
  const navigate = useNavigate();
  // Two entry modes:
  //   - dispatch: attachToTaskId is null → POST /api/generate then subscribe
  //   - attach:   attachToTaskId is a string → read queue entry → branch on
  //               status (pending/running → subscribe SSE; completed/error/
  //               cancelled → render terminal state without SSE).
  const [job, setJob] = useState(() => ({
    id: attachToTaskId ? `job_${attachToTaskId.slice(0, 8)}` : 'job_' + Date.now(),
    taskId: attachToTaskId || null,
    status: attachToTaskId ? 'rendering' : 'dispatching',
    progress: 0,
    // Attach mode starts in a "loading" limbo stage until we can read the
    // queue entry and branch. Dispatch mode starts properly "queued".
    stage: attachToTaskId ? 'loading' : 'queued',
    message: attachToTaskId ? '작업 정보 불러오는 중…' : '영상 만들기 요청 중…',
    videoUrl: null,
    error: null,
    startedAt: Date.now(),
  }));
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);
  // Read queue position + entry from the shared snapshot — no more 4s poll
  // here. Entry is the source of truth for created_at/started_at; falls back
  // to local timestamps for the dispatch path before the queue catches up.
  const queuePos = useQueuePosition(job.taskId);
  const queueEntry = useQueueEntry(job.taskId);
  const unsubRef = useRef(null);
  const dispatchedRef = useRef(false);
  const attachInitRef = useRef(false);

  // Lifted out of the useEffects so both branches share the same progress
  // handler without re-capturing stale state.
  const subscribeForUpdates = (taskId) => {
    const unsub = subscribeProgress(taskId, (evt) => {
      if (evt.error) {
        setJob(j => ({ ...j, status: 'error', error: '진행 상황 구독이 끊겼어요' }));
        return;
      }
      const raw = evt.progress;
      const progress = typeof raw === 'number'
        ? (raw <= 1 ? Math.round(raw * 100) : Math.round(raw))
        : null;
      // The worker's update_task only emits {stage, progress, message} —
      // there is no `status` field. Transition client job.status from
      // stage instead ("complete" / "error" are the terminal stages).
      const stage = evt.stage || null;
      setJob(j => ({
        ...j,
        progress: progress != null ? progress : j.progress,
        stage: stage || j.stage,
        message: evt.message || j.message,
        status: stage === 'complete' ? 'done'
          : stage === 'error' ? 'error'
          : j.status,
        videoUrl: evt.video_url || evt.path || j.videoUrl,
        error: stage === 'error' ? (evt.message || '영상 생성 중 오류가 발생했어요') : j.error,
      }));
    });
    unsubRef.current = unsub;
  };

  // 1a) Dispatch mode: POST /api/generate once on mount, then subscribe.
  useEffect(() => {
    if (attachToTaskId) return;         // handled by the attach-mode effect below
    if (dispatchedRef.current) return;
    dispatchedRef.current = true;

    (async () => {
      try {
        const audio_path = state.voice.generatedAudioPath
          || state.voice.uploadedAudio?.path
          || '';
        if (!audio_path) {
          throw new Error('음성 파일 경로를 찾을 수 없어요 (3단계에서 다시 만들기)');
        }
        const res = await generateVideo({ state, audio: { audio_path } });
        const taskId = res.task_id || res.id || null;
        setJob(j => ({
          ...j,
          taskId,
          status: taskId ? 'rendering' : 'done',
          progress: taskId ? 0 : 100,
          stage: taskId ? 'queued' : 'encode',
          videoUrl: res.video_url || res.path || null,
          message: taskId ? '대기열에 등록했어요' : '완료!',
        }));
        if (!taskId) return;
        subscribeForUpdates(taskId);
      } catch (err) {
        console.error('render dispatch failed', err);
        setJob(j => ({ ...j, status: 'error', error: humanizeError(err) }));
      }
    })();
    return () => {
      if (unsubRef.current) unsubRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1b) Attach mode: wait for the queue snapshot to contain this task_id,
  // then branch on queueEntry.status so we don't show "대기열 등록" for a
  // task that was completed hours ago. Runs at most once per taskId.
  useEffect(() => {
    if (!attachToTaskId) return;
    if (attachInitRef.current) return;
    if (!queueEntry) return;  // snapshot hasn't caught up yet

    attachInitRef.current = true;
    const qstatus = queueEntry.status;

    if (qstatus === 'completed') {
      // Already finished before we attached — kick straight to the
      // dedicated result page (no point flashing a live-progress shell).
      navigate(`/result/${attachToTaskId}`, { replace: true });
      return;
    }
    if (qstatus === 'error') {
      setJob(j => ({
        ...j,
        status: 'error',
        stage: 'error',
        error: queueEntry.error || '작업이 실패했어요',
      }));
      return;
    }
    if (qstatus === 'cancelled') {
      setJob(j => ({
        ...j,
        status: 'error',
        stage: 'error',
        error: '취소된 작업이에요',
      }));
      return;
    }
    // pending / running → subscribe for live updates. Seed message/stage
    // from the queue snapshot so we're not stuck on "작업 정보 불러오는 중".
    // SSE replays the full update history on connect, so progress/stage/
    // message converge to the current state within ~1s. The seeded values
    // are just a placeholder for that <1s window.
    setJob(j => ({
      ...j,
      status: 'rendering',
      stage: qstatus === 'pending' ? 'queued' : (j.stage === 'loading' ? 'generating' : j.stage),
      message: qstatus === 'pending' ? '대기 중이에요' : '영상 만드는 중이에요',
    }));
    subscribeForUpdates(attachToTaskId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachToTaskId, queueEntry]);

  // Cleanup the SSE subscription on unmount (shared across both branches).
  useEffect(() => () => {
    if (unsubRef.current) unsubRef.current();
  }, []);

  // When the live job flips to done, hand off to the dedicated result page.
  // The completion UI still exists in this component for the brief window
  // between SSE "complete" and the navigate — and as a safety net if the
  // manifest fetch fails. Normally users never see it long enough to notice.
  useEffect(() => {
    if (job.status === 'done' && job.taskId) {
      navigate(`/result/${job.taskId}`, { replace: true });
    }
  }, [job.status, job.taskId, navigate]);

  // Real resolution for the summary card — reads from the queue entry's
  // params (what was actually sent to the worker) when available. Falls
  // back to state.resolution only for in-wizard flow before the queue
  // catches up. Previously the card read state.resolution for every view,
  // which meant attaching to an old task showed whatever resolution the
  // user currently had picked in Step 3, not what the task actually rendered.
  const actualResolution = (() => {
    const raw = queueEntry?.params?.resolution;
    if (raw) {
      const m = /^(\d+)\s*x\s*(\d+)$/.exec(raw);
      if (m) {
        const [, h, w] = m;
        return { width: Number(w), height: Number(h), label: `${w}×${h}`, source: 'task' };
      }
    }
    const r = state.resolution;
    return r ? { width: r.width, height: r.height, label: r.label, source: 'state' } : null;
  })();

  // Real file size — HEAD /api/videos/{taskId} once the job is done to pull
  // Content-Length. The old "파일 용량" box showed an *estimate* tied to
  // state.resolution.size, which was the UI preset label (e.g., "~28MB")
  // not the actual output. Display shows "—" until the HEAD resolves.
  const [actualFileSize, setActualFileSize] = useState(null);
  useEffect(() => {
    if (job.status !== 'done' || !job.taskId) return;
    const controller = new AbortController();
    let alive = true;
    getVideoMeta(job.taskId, { signal: controller.signal })
      .then(meta => {
        if (!alive) return;
        if (meta.sizeBytes) setActualFileSize(meta.sizeBytes);
      })
      .catch(() => { /* silent — the card shows "—" */ });
    return () => { alive = false; controller.abort(); };
  }, [job.status, job.taskId]);

  const formatFileSize = (bytes) => {
    if (!bytes) return '—';
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    return `${Math.round(bytes / 1024)}KB`;
  };

  // Pick the right "elapsed since" anchor:
  //   - queueEntry.started_at (running): authoritative — what the worker
  //     actually started. Critical for attach mode (the task may have started
  //     long before this component mounted).
  //   - job.startedAt (dispatch path before queue snapshot lands): a few
  //     seconds of inaccuracy is fine.
  //   - queueEntry.completed_at - started_at (done): freezes the elapsed
  //     value at the true generation time instead of growing forever.
  const startedMs = queueEntry?.started_at ? new Date(queueEntry.started_at).getTime() : job.startedAt;
  const completedMs = queueEntry?.completed_at ? new Date(queueEntry.completed_at).getTime() : null;
  const isRunning = !!queueEntry?.started_at && !completedMs;

  // 2) Elapsed ticker (1s) — only ticks while the task is actually running;
  // pending tasks show "—" and finished tasks show the frozen elapsed value.
  useEffect(() => {
    if (job.status === 'done' || job.status === 'error') return;
    if (!isRunning && !job.startedAt) return;
    const tick = () => setElapsed(Date.now() - (Number.isFinite(startedMs) ? startedMs : job.startedAt));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [job.status, job.startedAt, startedMs, isRunning]);

  // Effective elapsed display value:
  //   - completed → frozen at (completed_at - started_at)
  //   - running   → live tick (state above)
  //   - pending   → null (we render "대기 중" instead of a clock)
  const displayElapsedMs = (() => {
    if (completedMs && Number.isFinite(startedMs)) return Math.max(0, completedMs - startedMs);
    if (isRunning) return elapsed;
    if (queueEntry && !queueEntry.started_at) return null;  // pending
    return elapsed;  // dispatch path before queue catches up
  })();

  const currentStageIdx = resolveStageIdx(job.stage, job.progress);

  const handleCopyShare = async () => {
    const url = job.videoUrl || (job.taskId ? `/api/videos/${job.taskId}` : null);
    if (!url) return;
    const link = url.startsWith('http') ? url : `${window.location.origin}${url}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* ignore */ }
  };

  // Worker SSE only emits {stage, progress, message, timestamp}; for attached
  // tasks (and even fresh ones) the completed video URL has to be derived from
  // task_id via /api/videos/. Keep job.videoUrl as the override when present.
  const playableVideoUrl = job.videoUrl || (job.taskId && job.status === 'done' ? `/api/videos/${job.taskId}` : null);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px 80px', background: 'var(--bg)', position: 'relative' }}>
      {job.status === 'done' && <Confetti />}
      <div style={{ maxWidth: 960, margin: '0 auto', position: 'relative', zIndex: 1 }}>
        <div className="flex justify-between items-center" style={{ marginBottom: 24 }}>
          <div>
            <div className="card-eyebrow">마지막 단계</div>
            <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.015em', margin: '2px 0 0' }}>
              {job.status === 'done' ? '영상이 완성됐어요!' : job.status === 'error' ? '만들기에 실패했어요' : '영상 만드는 중이에요'}
            </h1>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button icon="arrow_left" onClick={onBack}>앞으로 돌아가서 수정</Button>
            <Button icon="plus" variant="secondary" onClick={onReset}>새로 만들기</Button>
          </div>
        </div>

        <div className="card" style={{ padding: 24 }}>
          {/* alignItems: 'start' (NOT 'stretch') — when stretch was on, the
              long right column forced the grid row height way past 180×320,
              and the video container's aspect-ratio: 9/16 then computed
              WIDTH from that taller height (16/9×height ≈ 600px wide),
              spilling into the right column. align-self:start on the video
              container is belt-and-braces — even if a future change re-adds
              stretch, the video keeps its intrinsic 9:16 box. */}
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
              {job.status === 'done' && playableVideoUrl ? (
                <video
                  src={playableVideoUrl}
                  controls
                  preload="metadata"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : job.status === 'error' ? (
                <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff', textAlign: 'center', padding: 16 }}>
                  <div>
                    <Icon name="alert_circle" size={24} />
                    <div style={{ fontSize: 12, marginTop: 8, opacity: 0.9 }}>{job.error}</div>
                  </div>
                </div>
              ) : (
                <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff' }}>
                  <div style={{ textAlign: 'center', padding: 12 }}>
                    <div className="spinner" style={{ width: 24, height: 24, margin: '0 auto 10px', borderColor: 'oklch(1 0 0 / 0.2)', borderTopColor: '#fff' }} />
                    <div style={{ fontSize: 11, opacity: 0.85 }}>{STAGES[currentStageIdx]?.label || '준비 중'}</div>
                    {queuePos != null && queuePos > 0 && (
                      <div style={{ fontSize: 10, opacity: 0.7, marginTop: 4 }}>
                        앞에 {queuePos}개 작업이 있어요
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="flex-col gap-3" style={{ minWidth: 0 }}>
              <div className="flex justify-between items-center">
                <div>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>{formatTaskTitle(job.id, queueEntry?.type || 'generate')}</div>
                  <div className="text-xs text-tertiary">
                    {actualResolution
                      ? `${actualResolution.width}×${actualResolution.height} · 세로형`
                      : '—'}
                  </div>
                </div>
                {job.status === 'done' ? (
                  <Badge variant="success" icon="check_circle">완성!</Badge>
                ) : job.status === 'error' ? (
                  <Badge variant="warn" icon="alert_circle">오류</Badge>
                ) : (
                  <Badge variant="accent" icon="sparkles">{STAGES[currentStageIdx]?.label}</Badge>
                )}
              </div>

              {job.status !== 'done' && job.status !== 'error' && (
                <>
                  <div>
                    <div className="flex justify-between" style={{ marginBottom: 6, fontSize: 12 }}>
                      <span className="text-secondary">{job.message || STAGES[currentStageIdx]?.label}</span>
                      <span className="num mono text-secondary">{Math.floor(job.progress)}%</span>
                    </div>
                    <div className="progress"><div className="progress-bar" style={{ width: `${job.progress}%` }} /></div>
                  </div>
                  {/* Timestamps stack vertically — labels are long ("작업생성날짜") and
                       inline they wrapped messily on the narrow card column. */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-tertiary)' }}>
                    <span className="mono num">
                      {displayElapsedMs == null ? '경과 — (대기 중)' : `경과 ${formatElapsed(displayElapsedMs)}`}
                    </span>
                    {queueEntry?.created_at && (
                      <span title="작업이 작업 목록에 등록된 시각">작업생성날짜 {formatDateTime(queueEntry.created_at)}</span>
                    )}
                    {queueEntry?.started_at && (
                      <span title="실제 작업이 시작된 시각">작업시작날짜 {formatDateTime(queueEntry.started_at)}</span>
                    )}
                    {queuePos != null && queuePos > 0 && (
                      <span>대기열 {queuePos}번째</span>
                    )}
                  </div>
                  {/* Stage progress also vertical so the per-stage label can read
                       in full ("쇼호스트 움직임 만드는 중") instead of being squashed
                       into a 5-column grid. */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {STAGES.map((s, i) => {
                      const done = i < currentStageIdx;
                      const active = i === currentStageIdx;
                      return (
                        <div key={s.key} style={{
                          padding: '8px 10px',
                          background: done ? 'var(--success-soft)' : active ? 'var(--accent-soft)' : 'var(--bg-sunken)',
                          borderRadius: 6,
                          border: `1px solid ${done ? 'oklch(0.85 0.05 160)' : active ? 'var(--accent-soft-border)' : 'var(--border)'}`,
                          fontSize: 11,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}>
                          {done ? <Icon name="check" size={12} style={{ color: 'var(--success)' }} />
                            : active ? <span className="spinner" style={{ width: 11, height: 11 }} />
                            : <div style={{ width: 12, height: 12, borderRadius: 99, border: '1.5px solid var(--border-strong)' }} />}
                          <span className={done ? '' : (active ? '' : 'text-tertiary')}>{s.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {job.status === 'done' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                  <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
                    <div className="card-eyebrow">걸린 시간</div>
                    <div style={{ fontSize: 16, fontWeight: 600 }} className="num mono">{formatElapsed(displayElapsedMs ?? 0)}</div>
                    {queueEntry?.created_at && (
                      <div className="text-xs text-tertiary" style={{ marginTop: 2 }}>작업생성날짜 {formatDateTime(queueEntry.created_at)}</div>
                    )}
                  </div>
                  <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
                    <div className="card-eyebrow">파일 용량</div>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>{formatFileSize(actualFileSize)}</div>
                    {actualResolution && (
                      <div className="text-xs text-tertiary" style={{ marginTop: 2 }}>
                        {actualResolution.width}×{actualResolution.height}
                      </div>
                    )}
                  </div>
                  <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
                    <div className="card-eyebrow">파일 형식</div>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>MP4</div>
                  </div>
                </div>
              )}

              {/* 2×2 grid of action buttons on completion:
                    row 1 — 저장 + 공유 (what you do WITH the finished video)
                    row 2 — 수정 + 새로 (what you do NEXT)
                  The flex-wrap row before this packed them awkwardly on
                  narrower cards. `width: 100%` on the <a> makes the
                  download anchor fill its grid cell like the <Button>s. */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 'auto' }}>
                {job.status === 'done' && playableVideoUrl ? (
                  <>
                    <a
                      href={job.taskId ? `/api/videos/${job.taskId}?download=true` : playableVideoUrl}
                      download
                      className="btn btn-primary"
                      style={{ textDecoration: 'none', justifyContent: 'center' }}
                    >
                      <Icon name="download" size={14} /> 내 컴퓨터에 저장
                    </a>
                    <Button icon={copied ? 'check' : 'link'} onClick={handleCopyShare}>
                      {copied ? '링크 복사됨' : '공유 링크 복사'}
                    </Button>
                    <Button icon="refresh" onClick={onBack}>고쳐서 다시 만들기</Button>
                    <Button icon="plus" variant="primary" onClick={onReset}>영상 하나 더 만들기</Button>
                  </>
                ) : (
                  <>
                    <Button variant="primary" icon="download" disabled>내 컴퓨터에 저장</Button>
                    <Button icon="link" disabled>공유 링크 복사</Button>
                    <Button icon="refresh" disabled={job.status !== 'error'} onClick={onBack}>고쳐서 다시 만들기</Button>
                    <Button icon="plus" disabled onClick={onReset}>영상 하나 더 만들기</Button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {job.status !== 'done' && job.status !== 'error' && (
          <RenderHistory excludeTaskId={job.taskId} />
        )}
      </div>
    </div>
  );
};

export default RenderDashboard;
