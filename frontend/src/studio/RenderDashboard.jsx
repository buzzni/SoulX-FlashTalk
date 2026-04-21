import { useState, useEffect, useRef } from 'react';
import Icon from './Icon.jsx';
import { Badge, Button } from './primitives.jsx';
import { generateVideo, humanizeError, subscribeProgress } from './api.js';

// Render dashboard — final step after going through wizard.
// Dispatches /api/generate, then subscribes to /api/progress/{task_id} SSE.
const RenderDashboard = ({ state, onBack, onReset }) => {
  const [jobs, setJobs] = useState(() => [{
    id: 'job_' + Date.now(),
    status: 'rendering',
    progress: 0,
    stage: 'queued',
    message: '대기열에 등록 중…',
    taskId: null,
    videoUrl: null,
    startedAt: Date.now(),
    snapshot: state,
    error: null,
  }]);
  const [playing, setPlaying] = useState(false);
  const unsubRef = useRef(null);
  const dispatchedRef = useRef(false);

  const activeJob = jobs[0];

  const patchJob = (patch) => setJobs(js => js.map((j, i) => (i === 0 ? { ...j, ...patch } : j)));

  useEffect(() => {
    if (dispatchedRef.current) return;
    dispatchedRef.current = true;
    (async () => {
      try {
        const audio = {
          audio_path: state.voice.generatedAudioPath
            || state.voice.uploadedAudio?.path
            || '',
        };
        if (!audio.audio_path) throw new Error('음성 파일 경로를 찾을 수 없어요 (3단계에서 다시 만들기)');
        const res = await generateVideo({ state, audio });
        patchJob({ taskId: res.task_id || res.id || null });
        if (!res.task_id) {
          patchJob({ status: 'done', progress: 100, videoUrl: res.video_url || res.path });
          return;
        }
        const unsub = subscribeProgress(res.task_id, (evt) => {
          if (evt.error) {
            patchJob({ status: 'error', error: '진행 상황 구독이 끊겼어요' });
            return;
          }
          const progress = Math.round((evt.progress || 0) * (evt.progress > 1 ? 1 : 100));
          patchJob({
            progress: isNaN(progress) ? activeJob.progress : progress,
            stage: evt.stage || activeJob.stage,
            message: evt.message || activeJob.message,
            status: evt.status === 'completed' ? 'done' : (evt.status === 'error' ? 'error' : 'rendering'),
            videoUrl: evt.video_url || evt.path || null,
            error: evt.status === 'error' ? (evt.message || '영상 생성 중 오류가 발생했어요') : null,
          });
        });
        unsubRef.current = unsub;
      } catch (err) {
        console.error('render dispatch failed', err);
        patchJob({ status: 'error', error: humanizeError(err) });
      }
    })();
    return () => {
      if (unsubRef.current) unsubRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stages = [
    { key: 'host', label: '쇼호스트 움직임 만드는 중', done: activeJob.progress > 15 },
    { key: 'composite', label: '제품·배경 합치는 중', done: activeJob.progress > 40 },
    { key: 'audio', label: '목소리와 입 모양 맞추는 중', done: activeJob.progress > 65 },
    { key: 'encode', label: '영상 파일로 만드는 중', done: activeJob.progress > 95 },
  ];
  const currentStage = stages.find(s => !s.done) || stages[stages.length - 1];

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px 80px', background: 'var(--bg)' }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <div className="flex justify-between items-center" style={{ marginBottom: 24 }}>
          <div>
            <div className="card-eyebrow">마지막 단계</div>
            <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.015em', margin: '2px 0 0' }}>영상 만드는 중이에요</h1>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button icon="arrow_left" onClick={onBack}>앞으로 돌아가서 수정</Button>
            <Button icon="plus" variant="secondary" onClick={onReset}>새로 만들기</Button>
          </div>
        </div>

        {/* Active job card */}
        <div className="card" style={{ padding: 24 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 28, alignItems: 'stretch' }}>
            {/* Preview */}
            <div style={{ borderRadius: 12, overflow: 'hidden', background: '#0b0d12', aspectRatio: '9/16', position: 'relative', border: '1px solid var(--border)' }}>
              {activeJob.status === 'done' && activeJob.videoUrl ? (
                <video
                  src={activeJob.videoUrl}
                  controls
                  autoPlay={playing}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : activeJob.status === 'error' ? (
                <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff', textAlign: 'center', padding: 16 }}>
                  <div>
                    <Icon name="alert_circle" size={24} />
                    <div style={{ fontSize: 12, marginTop: 8, opacity: 0.9 }}>{activeJob.error}</div>
                  </div>
                </div>
              ) : (
                <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div className="spinner" style={{ width: 24, height: 24, margin: '0 auto 10px', borderColor: 'oklch(1 0 0 / 0.2)', borderTopColor: '#fff' }} />
                    <div style={{ fontSize: 11, opacity: 0.8 }}>{activeJob.message || '영상을 만드는 중이에요…'}</div>
                  </div>
                </div>
              )}
            </div>

            {/* Details */}
            <div className="flex-col gap-3" style={{ minWidth: 0 }}>
              <div className="flex justify-between items-center">
                <div>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>내 쇼호스트 영상 #{jobs[0].id.slice(-4).toUpperCase()}</div>
                  <div className="text-xs text-tertiary">{state.resolution.label} · {state.resolution.width}×{state.resolution.height} · 세로형</div>
                </div>
                {activeJob.status === 'done' ? (
                  <Badge variant="success" icon="check_circle">완성!</Badge>
                ) : (
                  <Badge variant="accent" icon="sparkles">{currentStage.label}</Badge>
                )}
              </div>

              {activeJob.status === 'rendering' && (
                <>
                  <div>
                    <div className="flex justify-between" style={{ marginBottom: 6, fontSize: 12 }}>
                      <span className="text-secondary">{currentStage.label}</span>
                      <span className="num mono text-secondary">{Math.floor(activeJob.progress)}%</span>
                    </div>
                    <div className="progress"><div className="progress-bar" style={{ width: `${activeJob.progress}%` }} /></div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
                    {stages.map(s => (
                      <div key={s.key} style={{ padding: '8px 10px', background: s.done ? 'var(--success-soft)' : 'var(--bg-sunken)', borderRadius: 6, border: `1px solid ${s.done ? 'oklch(0.85 0.05 160)' : 'var(--border)'}`, fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {s.done ? <Icon name="check" size={11} style={{ color: 'var(--success)' }} /> : <div style={{ width: 11, height: 11, borderRadius: 99, border: '1.5px solid var(--border-strong)' }} />}
                        <span className={s.done ? '' : 'text-tertiary'}>{s.label}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {activeJob.status === 'done' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                  <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
                    <div className="card-eyebrow">영상 길이</div>
                    <div style={{ fontSize: 16, fontWeight: 600 }} className="num">32초</div>
                  </div>
                  <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
                    <div className="card-eyebrow">파일 용량</div>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>{state.resolution.size}</div>
                  </div>
                  <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
                    <div className="card-eyebrow">파일 형식</div>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>MP4 (어디든 재생됨)</div>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                <Button variant="primary" icon="download" disabled={activeJob.status !== 'done'}>내 컴퓨터에 저장</Button>
                <Button icon="link" disabled={activeJob.status !== 'done'}>공유 링크 만들기</Button>
                <Button icon="refresh" disabled={activeJob.status !== 'done'} onClick={onBack}>고쳐서 다시 만들기</Button>
                <Button icon="copy" disabled={activeJob.status !== 'done'}>똑같이 하나 더</Button>
              </div>
            </div>
          </div>
        </div>

        {/* Config summary */}
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
