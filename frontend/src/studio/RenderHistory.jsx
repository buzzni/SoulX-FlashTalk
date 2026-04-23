// RenderHistory — compact list of past completed videos shown beneath the
// progress card while the user waits. Plays inline on click so users have
// something to do during long FlashTalk inferences (60-180s+ per job).
import { useState, useEffect } from 'react';
import Icon from './Icon.jsx';
import { fetchHistory } from './api.js';

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

export default function RenderHistory({ excludeTaskId, limit = 8 }) {
  const [items, setItems] = useState(null);
  const [playing, setPlaying] = useState(null);
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
  const visible = excludeTaskId ? items.filter(v => v.task_id !== excludeTaskId) : items;
  if (visible.length === 0) return null;

  return (
    <div className="card mt-4">
      <div className="card-eyebrow">기다리는 동안 — 이전에 만든 영상 ({visible.length})</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        {visible.map(v => {
          const isOpen = playing === v.task_id;
          if (isOpen) {
            return (
              <div
                key={v.task_id}
                style={{
                  background: 'var(--bg-sunken)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 10,
                }}
              >
                <div className="flex justify-between items-center" style={{ marginBottom: 8 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="truncate" style={{ fontSize: 13, fontWeight: 500 }}>
                      {v.script_text || '제목 없음'}
                    </div>
                    <div className="text-xs text-tertiary">
                      {relativeTime(v.timestamp)}
                      {v.generation_time != null && ` · ${v.generation_time}초 걸림`}
                      {v.file_size ? ` · ${formatBytes(v.file_size)}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => setPlaying(null)}
                    style={{
                      background: 'transparent',
                      border: 0,
                      cursor: 'pointer',
                      color: 'var(--text-tertiary)',
                      padding: 4,
                    }}
                    aria-label="닫기"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
                <video
                  src={v.video_url}
                  controls
                  autoPlay
                  style={{
                    width: '100%',
                    maxHeight: 260,
                    borderRadius: 6,
                    background: '#000',
                    display: 'block',
                  }}
                />
              </div>
            );
          }
          return (
            <button
              key={v.task_id}
              onClick={() => setPlaying(v.task_id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                background: 'var(--bg-sunken)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
                color: 'inherit',
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: 'var(--accent-soft)',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                <Icon name="play" size={12} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="truncate" style={{ fontSize: 13, fontWeight: 500 }}>
                  {v.script_text || '제목 없음'}
                </div>
                <div className="text-xs text-tertiary">
                  {relativeTime(v.timestamp)}
                  {v.generation_time != null && ` · ${v.generation_time}초`}
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
