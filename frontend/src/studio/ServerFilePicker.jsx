// Picker for files already on the server's uploads/ dir. DLP/VPN environments
// often block browser uploads but allow scp/rsync over SSH — so the workflow is:
// user runs `scp foo.png <server>:<project>/uploads/` once, then opens this
// picker and selects from the list. No browser file-read needed.
import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { listServerFiles } from './api.js';

export default function ServerFilePicker({ open, onClose, onSelect, kind = 'image' }) {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [recentOnly, setRecentOnly] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await listServerFiles(kind);
      setFiles(r.files || []);
    } catch (err) {
      setError(err.message || '목록 조회 실패');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind]);

  if (!open) return null;

  const ONE_HOUR = 60 * 60;
  const nowSec = Date.now() / 1000;
  const filtered = (files || []).filter(f => {
    if (recentOnly && nowSec - f.modified > ONE_HOUR) return false;
    if (query && !f.filename.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  const formatSize = (b) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  };
  const formatTime = (t) => new Date(t * 1000).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'oklch(0.22 0.01 260 / 0.4)', backdropFilter: 'blur(4px)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-elev)', borderRadius: 'var(--r-xl)', maxWidth: 840, width: '100%', maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', border: '1px solid var(--border)' }}>
        <div className="modal-header" style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>서버에 있는 파일에서 선택</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
              업로드가 막히는 환경에서는 <code style={{ background: 'var(--bg-sunken)', padding: '1px 5px', borderRadius: 3, fontFamily: 'monospace', fontSize: 11 }}>scp foo.png 서버:프로젝트/uploads/</code> 로 올린 뒤 여기서 고르세요.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={refresh} className="btn btn-ghost btn-sm btn-icon" title="새로고침" aria-label="새로고침">
              <Icon name="refresh" size={14} />
            </button>
            <button onClick={onClose} className="btn btn-ghost btn-sm btn-icon" aria-label="닫기">
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>

        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg-sunken)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="파일명 검색…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
            style={{
              flex: 1,
              minWidth: 200,
              padding: '6px 10px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)',
              fontSize: 13,
              background: 'var(--bg-elev)',
            }}
          />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={recentOnly} onChange={e => setRecentOnly(e.target.checked)} />
            최근 1시간만
          </label>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            {files ? `${filtered.length} / ${files.length} 개` : ''}
          </span>
        </div>

        <div style={{ padding: 20, overflow: 'auto', flex: 1, minHeight: 0 }}>
          {loading && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>
              <span className="spinner" style={{ width: 18, height: 18, display: 'inline-block', marginRight: 8, verticalAlign: 'middle' }} />
              불러오는 중…
            </div>
          )}

          {error && (
            <div style={{ padding: 14, background: 'var(--danger-soft)', border: '1px solid var(--danger)', borderRadius: 'var(--r-sm)', color: 'var(--danger)', fontSize: 13 }}>
              <Icon name="alert_circle" size={13} style={{ marginRight: 6, verticalAlign: 'middle' }} />
              {error}
            </div>
          )}

          {!loading && !error && files && files.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
              서버에 해당 유형의 파일이 없어요. 먼저 <code style={{ background: 'var(--bg-sunken)', padding: '1px 5px', borderRadius: 3 }}>scp</code> 로 업로드해주세요.
            </div>
          )}

          {!loading && !error && files && files.length > 0 && filtered.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
              검색 결과가 없어요. 검색어를 지우거나 "최근 1시간만" 체크를 해제해보세요.
            </div>
          )}

          {!loading && !error && filtered.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
              {filtered.map(f => (
                <button
                  key={f.path}
                  onClick={() => { onSelect(f); onClose(); }}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r-md)',
                    padding: 0,
                    background: 'var(--bg-elev)',
                    cursor: 'pointer',
                    overflow: 'hidden',
                    textAlign: 'left',
                    display: 'flex',
                    flexDirection: 'column',
                    transition: 'all .12s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px oklch(0.55 0.15 255 / 0.15)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = ''; }}
                >
                  <div style={{ aspectRatio: '1 / 1', background: '#0b0d12', overflow: 'hidden', position: 'relative' }}>
                    {kind === 'image' ? (
                      <img src={f.url} alt={f.filename} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                    ) : (
                      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--text-tertiary)' }}>
                        <Icon name="sound" size={28} />
                      </div>
                    )}
                  </div>
                  <div style={{ padding: '8px 10px', fontSize: 11 }}>
                    <div className="truncate" style={{ fontWeight: 500, color: 'var(--text)' }}>{f.filename}</div>
                    <div className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2, display: 'flex', justifyContent: 'space-between' }}>
                      <span>{formatSize(f.size)}</span>
                      <span>{formatTime(f.modified)}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
