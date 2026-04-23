// Render dashboard — final step after going through wizard.
// Dispatches /api/generate, subscribes to /api/progress/{task_id} SSE, polls
// /api/queue for queue position, and shows per-stage progress + completion CTA.
import { useState, useEffect, useRef } from 'react';
import Icon from './Icon.jsx';
import { Badge, Button } from './primitives.jsx';
import { generateVideo, humanizeError, subscribeProgress } from './api.js';
import { useQueueEntry, useQueuePosition } from './QueueContext.jsx';
import RenderHistory from './RenderHistory.jsx';

const STAGES = [
  { key: 'queued', label: '대기열 등록 중' },
  { key: 'composite', label: '제품·배경 합치는 중' },
  { key: 'voice', label: '목소리와 입 모양 맞추는 중' },
  { key: 'render', label: '쇼호스트 움직임 만드는 중' },
  { key: 'encode', label: '영상 파일로 만드는 중' },
];

const STAGE_ORDER = STAGES.map(s => s.key);

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
  // Two entry modes:
  //   - dispatch: attachToTaskId is null → POST /api/generate then subscribe
  //   - attach:   attachToTaskId is a string → skip dispatch, subscribe directly
  // Attach is what powers QueueStatus click-to-monitor.
  const [job, setJob] = useState(() => ({
    id: attachToTaskId ? `job_${attachToTaskId.slice(0, 8)}` : 'job_' + Date.now(),
    taskId: attachToTaskId || null,
    status: attachToTaskId ? 'rendering' : 'dispatching',
    progress: 0,
    stage: 'queued',
    message: attachToTaskId ? '실행 중인 작업에 연결 중…' : '영상 만들기 요청 중…',
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

  // 1) On mount: either dispatch a new /api/generate or attach to an existing
  // task_id, then subscribe to SSE progress in both cases.
  useEffect(() => {
    if (dispatchedRef.current) return;
    dispatchedRef.current = true;

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
        setJob(j => ({
          ...j,
          progress: progress != null ? progress : j.progress,
          stage: evt.stage || j.stage,
          message: evt.message || j.message,
          status: evt.status === 'completed' ? 'done'
            : evt.status === 'error' ? 'error'
            : j.status,
          videoUrl: evt.video_url || evt.path || j.videoUrl,
          error: evt.status === 'error' ? (evt.message || '영상 생성 중 오류가 발생했어요') : j.error,
        }));
      });
      unsubRef.current = unsub;
    };

    (async () => {
      // Attach mode: skip dispatch, hook straight into the existing task's
      // progress stream. The task entry stays the source of truth for
      // resolution/script/etc.; we only watch progress here.
      if (attachToTaskId) {
        subscribeForUpdates(attachToTaskId);
        return;
      }

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

  const currentStageIdx = Math.max(0, STAGE_ORDER.indexOf(job.stage));

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
          <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 28, alignItems: 'stretch' }}>
            <div style={{ borderRadius: 12, overflow: 'hidden', background: '#0b0d12', aspectRatio: '9/16', position: 'relative', border: '1px solid var(--border)' }}>
              {job.status === 'done' && playableVideoUrl ? (
                <video
                  src={playableVideoUrl}
                  controls
                  autoPlay
                  loop
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
                  <div style={{ fontSize: 16, fontWeight: 600 }}>내 쇼호스트 영상 #{job.id.slice(-4).toUpperCase()}</div>
                  <div className="text-xs text-tertiary">
                    {state.resolution.label} · {state.resolution.width}×{state.resolution.height} · 세로형
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
                    <div style={{ fontSize: 16, fontWeight: 600 }}>{state.resolution.size}</div>
                  </div>
                  <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
                    <div className="card-eyebrow">파일 형식</div>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>MP4</div>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 'auto', flexWrap: 'wrap' }}>
                {job.status === 'done' && playableVideoUrl ? (
                  <>
                    <a
                      href={job.taskId ? `/api/videos/${job.taskId}?download=true` : playableVideoUrl}
                      download
                      className="btn btn-primary"
                      style={{ textDecoration: 'none' }}
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
                    <Button icon="link" disabled>공유 링크</Button>
                    <Button icon="refresh" disabled={job.status !== 'error'} onClick={onBack}>고쳐서 다시 만들기</Button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {job.status !== 'done' && job.status !== 'error' && (
          <RenderHistory excludeTaskId={job.taskId} />
        )}

        <div className="card mt-4">
          <div className="card-eyebrow">이렇게 만들었어요</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginTop: 8 }}>
            <div>
              <div className="text-xs text-tertiary">쇼호스트</div>
              <div style={{ fontWeight: 500, marginTop: 2 }}>{state.host.mode === 'text' ? '설명으로 만들기' : '사진으로 만들기'}</div>
              <div className="text-xs text-tertiary">후보 {state.host.selectedSeed ?? '—'}번 선택</div>
            </div>
            <div>
              <div className="text-xs text-tertiary">소개할 제품</div>
              <div style={{ fontWeight: 500, marginTop: 2 }} className="num">{state.products.length}개</div>
              <div className="text-xs text-tertiary truncate">{state.products.map(p => p.name).join(', ') || '—'}</div>
            </div>
            <div>
              <div className="text-xs text-tertiary">배경</div>
              <div style={{ fontWeight: 500, marginTop: 2 }}>{
                state.background.source === 'preset' ? '추천 장소' :
                state.background.source === 'prompt' ? '직접 만들기' :
                state.background.source === 'upload' ? '내 사진' :
                state.background.source === 'url' ? '링크' : '—'
              }</div>
            </div>
            <div>
              <div className="text-xs text-tertiary">목소리</div>
              <div style={{ fontWeight: 500, marginTop: 2 }}>{state.voice.voiceName || (state.voice.uploadedAudio ? '녹음 파일' : '—')}</div>
              <div className="text-xs text-tertiary">{state.voice.source === 'tts' ? '목소리 고르기' : state.voice.source === 'clone' ? '내 목소리 복제' : '녹음 파일 업로드'}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RenderDashboard;
