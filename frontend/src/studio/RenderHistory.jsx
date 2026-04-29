// RenderHistory — compact list of past completed videos shown beneath the
// progress card while the user waits. Plays inline on click so users have
// something to do during long FlashTalk inferences (60-180s+ per job).
import { useState, useEffect } from 'react';
import Icon from './Icon.jsx';
import { fetchHistory } from './api.js';
import { formatTaskTitle } from './taskFormat.js';
import { resolveBackendUrl } from '../lib/format';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function relativeTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const dt = Date.now() - t;
  if (dt < MIN) return '방금';
  if (dt < HOUR) return `${Math.floor(dt / MIN)}분 전`;
  if (dt < DAY) return `${Math.floor(dt / HOUR)}시간 전`;
  return `${Math.floor(dt / DAY)}일 전`;
}

function formatBytes(n) {
  if (!n) return '';
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.round(n / 1024)}KB`;
}

// Match ResultPage's `m:ss` duration format so the same elapsed number reads
// the same way everywhere (previously we had "183.42초 걸림" here vs "3:03"
// on the result page — inconsistent).
function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '';
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}


export default function RenderHistory({ excludeTaskId, limit = 8 }) {
  const [items, setItems] = useState(null);
  const [playing, setPlaying] = useState(null);
  const [playError, setPlayError] = useState({}); // task_id -> true once <video> errors
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchHistory(limit)
      .then(d => { if (alive) setItems(d.videos || []); })
      .catch(err => { if (alive) setError(err.message || '히스토리 조회 실패'); });
    return () => { alive = false; };
  }, [limit]);

  if (error) return null; // silent failure — history is non-critical UI
  if (items == null) return null; // loading
  // Defense-in-depth: even though fetchHistory now passes status=completed,
  // older API responses or schema drift could leak non-completed rows.
  // Drop anything that isn't explicitly "completed" so the inline <video>
  // never points at a 404.
  const completed = items.filter(v => !v.status || v.status === 'completed');
  const visible = excludeTaskId ? completed.filter(v => v.task_id !== excludeTaskId) : completed;
  if (visible.length === 0) return null;

  return (
    <div className="surface-base p-5 mt-4">
      <div className="text-2xs uppercase tracking-widest font-semibold text-muted-foreground">기다리는 동안 — 이전에 만든 영상 ({visible.length})</div>
      <div className="flex flex-col gap-1.5 mt-3">
        {visible.map(v => {
          const isOpen = playing === v.task_id;
          if (isOpen) {
            return (
              <div
                key={v.task_id}
                className="bg-secondary border border-border rounded-lg p-2.5"
              >
                <div className="flex justify-between items-center mb-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm-tight font-medium">
                      {formatTaskTitle(v.task_id, v.type || 'generate')}
                    </div>
                    {v.script_text && (
                      <div className="truncate text-xs text-ink-2 mt-0.5">
                        {v.script_text}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {relativeTime(v.timestamp)}
                      {v.generation_time != null && ` · ${formatDuration(v.generation_time)}`}
                      {v.file_size ? ` · ${formatBytes(v.file_size)}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => setPlaying(null)}
                    className="bg-transparent border-0 cursor-pointer text-ink-3 p-1"
                    aria-label="닫기"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
                {playError[v.task_id] ? (
                  <div className="grid place-items-center w-full h-[160px] rounded-md bg-black text-xs text-muted-foreground">
                    영상을 불러올 수 없어요
                  </div>
                ) : (
                  <video
                    src={resolveBackendUrl(v.video_url)}
                    controls
                    autoPlay
                    muted
                    playsInline
                    preload="metadata"
                    onError={() => setPlayError(prev => ({ ...prev, [v.task_id]: true }))}
                    className="block w-full max-h-[260px] rounded-md bg-black"
                  />
                )}
              </div>
            );
          }
          return (
            <button
              key={v.task_id}
              onClick={() => setPlaying(v.task_id)}
              className="flex items-center gap-2.5 px-2.5 py-2 bg-secondary border border-border rounded-lg cursor-pointer text-left font-sans text-inherit"
            >
              <div className="grid place-items-center w-7 h-7 rounded-md bg-primary text-primary-foreground shrink-0">
                <Icon name="play" size={12} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm-tight font-medium">
                  {formatTaskTitle(v.task_id, v.type || 'generate')}
                </div>
                {v.script_text && (
                  <div className="truncate text-xs text-ink-2 mt-0.5">
                    {v.script_text}
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  {relativeTime(v.timestamp)}
                  {v.generation_time != null && ` · ${formatDuration(v.generation_time)}`}
                  {v.file_size ? ` · ${formatBytes(v.file_size)}` : ''}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
