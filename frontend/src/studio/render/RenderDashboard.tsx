/**
 * RenderDashboard — live progress view for a video-generation job.
 *
 * Post-Phase-4d: the state machinery that used to live inline
 * (two parallel SSE/polling handlers + elapsed ticker + stage
 * grouping) is now inside useRenderJob. The container handles
 * only:
 *   1. Dispatch-mode: POST /api/generate once on mount, then
 *      set the taskId so useRenderJob takes over.
 *   2. Attach-mode: read the queue entry; if terminal, redirect
 *      or show error; if still live, just let useRenderJob run.
 *   3. On done: navigate to /result/:taskId.
 *   4. File-size fetch via getVideoMeta on completion.
 *
 * Everything else is UI composition.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WizardBadge as Badge } from '@/components/wizard-badge';
import { WizardButton as Button } from '@/components/wizard-button';
import { generateVideo } from '../../api/video';
import { getVideoMeta } from '../../api/file';
import { humanizeError } from '../../api/http';
import { useRenderJob } from '../../hooks/useRenderJob';
import { useQueuePosition } from '../../stores/queueStore';
import { RESOLUTION_META } from '../../wizard/schema';
import { formatTaskTitle } from '../taskFormat.js';
import RenderHistory from '../RenderHistory.jsx';
import { Confetti } from '../shared/Confetti';
import { RenderPreview } from './RenderPreview';
import { ProgressCard } from './ProgressCard';
import { RenderStats } from './RenderStats';
import { RenderActions } from './RenderActions';
import { STAGES, resolveStageIdx } from './stages';

export interface RenderDashboardProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  attachToTaskId?: string | null;
  onBack: () => void;
  onReset: () => void;
}

type Status = 'pending' | 'dispatching' | 'rendering' | 'done' | 'error';

export default function RenderDashboard({
  state,
  attachToTaskId = null,
  onBack,
  onReset,
}: RenderDashboardProps) {
  const navigate = useNavigate();
  // `taskId` never changes over a component's lifetime here —
  // RenderLayout uses `key={attachToTaskId || 'fresh'}` to force a
  // remount whenever the id changes, and dispatch-mode navigates to
  // `/render/:taskId` (which swaps to the attach page) rather than
  // mutating local state. Leaving it as a const flags the "immutable
  // for this mount" invariant and drops the unused setter.
  const taskId: string | null = attachToTaskId;
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const dispatchedRef = useRef(false);

  // Single source of truth for everything that was formerly in `job`.
  const job = useRenderJob(taskId);
  const queuePos = useQueuePosition(taskId);

  // ── Dispatch: POST /api/generate once, then let useRenderJob handle
  //    the rest. Attach mode skips this entirely (taskId already set).
  //
  //    Cleanup cancels the in-flight POST and guards the async
  //    continuation from firing after unmount. Without this, a user who
  //    hit back/close during the 1-3s dispatch window could get yanked
  //    back to /render/:taskId after the response landed because
  //    react-router's `navigate()` still mutates the URL from an
  //    unmounted component.
  //
  //    `state` is intentionally omitted from deps — we read it once at
  //    dispatch time. A wizard field update mid-dispatch shouldn't tear
  //    down the in-flight POST.
  useEffect(() => {
    if (attachToTaskId) return;
    if (dispatchedRef.current) return;
    dispatchedRef.current = true;

    const controller = new AbortController();
    let alive = true;

    (async () => {
      try {
        // Phase 2c.4: voice is schema-typed. Audio path lives on
        // `voice.generation.audio.path` (tts/clone) or
        // `voice.audio.path` if it's a server-side ServerAsset
        // (upload). LocalAsset upload-mode = still uploading,
        // surface the same "missing audio" error.
        const audio_path = (() => {
          const v = state.voice;
          if (!v || typeof v !== 'object') return '';
          if (v.source === 'upload') {
            const a = v.audio;
            return a && typeof a === 'object' && 'path' in a ? (a.path as string) : '';
          }
          const gen = v.generation;
          if (gen && gen.state === 'ready' && gen.audio?.path) return gen.audio.path as string;
          return '';
        })();
        if (!audio_path) {
          throw new Error('음성 파일 경로를 찾을 수 없어요 (3단계에서 다시 만들기)');
        }
        const res = await generateVideo(
          { state, audio: { audio_path } },
          { signal: controller.signal },
        );
        if (!alive) return;
        // Backend contract (`app.py` `/api/generate`): always returns
        // `{task_id, message, queue_position}` on 200, errors via
        // HTTPException. No synchronous-complete branch exists, so a
        // missing `task_id` here would be an actual backend regression
        // — surface it as an error rather than silently succeeding.
        const id = res.task_id as string | undefined;
        if (!id) {
          throw new Error('서버가 task_id를 돌려주지 않았어요');
        }
        // Promote the URL from /render → /render/:taskId so refresh
        // survives and the task is permalink-able. `replace: true` so
        // the back button skips the transient dispatch URL. No
        // `setTaskId(id)` here — the URL change causes RenderAttachPage
        // to own the route, and RenderLayout's `key=attachToTaskId ||
        // 'fresh'` forces a full remount with the id as a prop.
        navigate(`/render/${id}`, { replace: true });
      } catch (err) {
        // AbortError = user navigated away mid-dispatch. Quiet exit.
        if ((err as { name?: string })?.name === 'AbortError') return;
        if (!alive) return;
        // eslint-disable-next-line no-console
        console.error('render dispatch failed', err);
        setDispatchError(humanizeError(err));
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
    // `state` is deliberately excluded — see the comment block above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachToTaskId, navigate]);

  // ── Attach mode: if the task already finished before we attached,
  //    redirect to /result. Terminal errors surface as dispatchError so
  //    the UI reuses the same code path as a dispatch failure.
  useEffect(() => {
    if (!attachToTaskId) return;
    const entry = job.entry;
    if (!entry) return; // snapshot hasn't landed yet
    if (entry.status === 'completed') {
      navigate(`/result/${attachToTaskId}`, { replace: true });
    } else if (entry.status === 'cancelled') {
      setDispatchError('취소된 작업이에요');
    }
    // running / pending / error: useRenderJob drives the display
  }, [attachToTaskId, job.entry, navigate]);

  // ── When useRenderJob flips to done, hand off to /result.
  useEffect(() => {
    if (job.isDone && taskId) {
      navigate(`/result/${taskId}`, { replace: true });
    }
  }, [job.isDone, taskId, navigate]);

  // ── Real file size via HEAD once the job completes.
  const [actualFileSize, setActualFileSize] = useState<number | null>(null);
  useEffect(() => {
    if (!job.isDone || !taskId) return;
    const controller = new AbortController();
    let alive = true;
    getVideoMeta(taskId, { signal: controller.signal })
      .then((meta) => {
        if (!alive) return;
        if (meta.sizeBytes) setActualFileSize(meta.sizeBytes);
      })
      .catch(() => {
        /* silent — the stat card shows "—" */
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [job.isDone, taskId]);

  // Derived display values ──

  // Real resolution for the summary card — reads from the queue entry's
  // params (what was actually sent to the worker) when available. Falls
  // back to state.resolution only for in-wizard flow before queue catches up.
  const resolutionParam = job.entry?.params?.resolution as string | undefined;
  const actualResolution = (() => {
    if (resolutionParam) {
      const m = /^(\d+)\s*x\s*(\d+)$/.exec(resolutionParam);
      if (m) {
        const [, h, w] = m;
        return { width: Number(w), height: Number(h), label: `${w}×${h}` };
      }
    }
    // Phase 2c: state.resolution is a ResolutionKey now — look up
    // dimensions via RESOLUTION_META.
    const key = state.resolution;
    if (!key) return null;
    const meta = RESOLUTION_META[key as keyof typeof RESOLUTION_META];
    return meta ? { width: meta.width, height: meta.height, label: meta.label } : null;
  })();

  // Overall status — aggregates dispatchError, useRenderJob flags, and the
  // dispatching fallback during the first tick before taskId lands.
  const status: Status = dispatchError
    ? 'error'
    : job.isError
      ? 'error'
      : job.isDone
        ? 'done'
        : !taskId
          ? 'dispatching'
          : 'rendering';

  const errorMessage: string | null =
    dispatchError ||
    (job.entry?.status === 'error' ? job.entry.error ?? '작업이 실패했어요' : null) ||
    (job.pollFailed ? '진행 상황 구독이 끊겼어요' : null);

  const progressPct = (() => {
    const raw = job.progress;
    if (typeof raw !== 'number') return 0;
    return raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
  })();
  const currentStageIdx = resolveStageIdx(job.stage, progressPct);

  // Video URLs — /api/videos/:task_id is the canonical playback URL.
  const playableVideoUrl =
    status === 'done' && taskId ? `/api/videos/${taskId}` : null;
  const downloadUrl = taskId ? `/api/videos/${taskId}?download=true` : null;

  const handleCopyShare = async () => {
    const url = playableVideoUrl;
    if (!url) return;
    const link = url.startsWith('http') ? url : `${window.location.origin}${url}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore clipboard failures — shows "링크 복사됨" without propagating */
    }
  };

  const jobTitleId = taskId ?? `job_${Date.now()}`;

  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '28px 32px 80px',
        background: 'var(--bg)',
        position: 'relative',
      }}
    >
      {status === 'done' && <Confetti />}
      <div style={{ maxWidth: 960, margin: '0 auto', position: 'relative', zIndex: 1 }}>
        <div className="flex justify-between items-center" style={{ marginBottom: 24 }}>
          <div>
            <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground">마지막 단계</div>
            <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.015em', margin: '2px 0 0' }}>
              {status === 'done'
                ? '영상이 완성됐어요!'
                : status === 'error'
                  ? '만들기에 실패했어요'
                  : '영상 만드는 중이에요'}
            </h1>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button icon="arrow_left" onClick={onBack}>
              앞으로 돌아가서 수정
            </Button>
            <Button icon="plus" variant="secondary" onClick={onReset}>
              새로 만들기
            </Button>
          </div>
        </div>

        <div className="surface-base p-5" style={{ padding: 24 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '220px 1fr',
              gap: 28,
              alignItems: 'start',
            }}
          >
            <RenderPreview
              status={status === 'dispatching' ? 'rendering' : status}
              videoUrl={playableVideoUrl}
              errorMessage={errorMessage}
              stageLabel={STAGES[currentStageIdx]?.label ?? null}
              queuePosition={queuePos}
            />

            <div className="flex-col gap-3" style={{ minWidth: 0 }}>
              <div className="flex justify-between items-center">
                <div>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>
                    {formatTaskTitle(jobTitleId, job.entry?.type || 'generate')}
                  </div>
                  <div className="text-xs text-tertiary">
                    {actualResolution
                      ? `${actualResolution.width}×${actualResolution.height} · 세로형`
                      : '—'}
                  </div>
                </div>
                {status === 'done' ? (
                  <Badge variant="success" icon="check_circle">
                    완성!
                  </Badge>
                ) : status === 'error' ? (
                  <Badge variant="warn" icon="alert_circle">
                    오류
                  </Badge>
                ) : (
                  <Badge variant="accent" icon="sparkles">
                    {STAGES[currentStageIdx]?.label}
                  </Badge>
                )}
              </div>

              {status !== 'done' && status !== 'error' && (
                <ProgressCard
                  currentStageIdx={currentStageIdx}
                  progressPct={progressPct}
                  message={job.message}
                  elapsedMs={job.elapsedMs}
                  createdAt={job.entry?.created_at}
                  startedAt={job.entry?.started_at}
                  queuePosition={queuePos}
                />
              )}

              {status === 'done' && (
                <RenderStats
                  elapsedMs={job.elapsedMs}
                  createdAt={job.entry?.created_at}
                  fileSizeBytes={actualFileSize}
                  resolutionLabel={
                    actualResolution
                      ? `${actualResolution.width}×${actualResolution.height}`
                      : null
                  }
                />
              )}

              <RenderActions
                status={status === 'dispatching' ? 'rendering' : status}
                playableVideoUrl={playableVideoUrl}
                downloadUrl={downloadUrl}
                copied={copied}
                onCopyShare={handleCopyShare}
                onBack={onBack}
                onReset={onReset}
              />
            </div>
          </div>
        </div>

        {status !== 'done' && status !== 'error' && (
          <RenderHistory excludeTaskId={taskId} />
        )}
      </div>
    </div>
  );
}
