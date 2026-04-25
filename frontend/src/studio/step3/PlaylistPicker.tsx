/**
 * PlaylistPicker — Step 3 footer playlist assignment.
 *
 * Lets the user assign the about-to-render video to a playlist (or leave
 * unassigned = "미지정"). Inline-create uses POST /api/playlists; the new
 * playlist auto-selects per plan §6.
 *
 * Graceful degradation per plan decision #13: if /api/playlists fails to
 * load, render the notice + retry button. The user can still ship the
 * render — it lands in 미지정.
 */

import { useEffect, useState } from 'react';
import Icon from '../Icon.jsx';
import { Button } from '../primitives.jsx';
import { listPlaylists, createPlaylist, type Playlist } from '../../api/playlists';
import { humanizeError } from '../../api/http';

export interface PlaylistPickerProps {
  selected: string | null; // playlist_id or null = 미지정
  onChange: (playlistId: string | null) => void;
}

const CREATE_TOKEN = '__create__';

export function PlaylistPicker({ selected, onChange }: PlaylistPickerProps) {
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadList = async (signal?: AbortSignal) => {
    setLoadError(null);
    try {
      const r = await listPlaylists({ signal });
      const sorted = [...r.playlists].sort((a, b) =>
        a.name.localeCompare(b.name, 'ko'),
      );
      setPlaylists(sorted);
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return;
      setLoadError(humanizeError(e));
    }
  };

  useEffect(() => {
    const ctl = new AbortController();
    loadList(ctl.signal);
    return () => ctl.abort();
  }, []);

  const closeCreate = () => {
    setShowCreate(false);
    setNewName('');
    setCreateError(null);
  };

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    setCreateError(null);
    try {
      const p = await createPlaylist(trimmed);
      setPlaylists((cur) => {
        const next = [...(cur ?? []), p];
        next.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
        return next;
      });
      onChange(p.playlist_id);
      closeCreate();
    } catch (e) {
      setCreateError(humanizeError(e));
    } finally {
      setCreating(false);
    }
  };

  // Graceful degradation — playlist list unreachable. User can still ship.
  if (loadError) {
    return (
      <div style={errorStyle}>
        <Icon name="alert_circle" size={13} style={{ color: 'var(--warn)' }} />
        <span>플레이리스트 목록을 못 불러왔어요 · 이번 영상은 미지정으로 저장됩니다</span>
        <Button size="sm" variant="ghost" onClick={() => loadList()}>
          다시 시도
        </Button>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <label style={labelStyle}>플레이리스트</label>
      <select
        value={selected ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CREATE_TOKEN) {
            setShowCreate(true);
            return;
          }
          onChange(v === '' ? null : v);
        }}
        style={selectStyle}
        disabled={playlists === null}
      >
        <option value="">미지정</option>
        {playlists?.map((p) => (
          <option key={p.playlist_id} value={p.playlist_id}>
            {p.name}
          </option>
        ))}
        <option disabled value="__sep__">──────────</option>
        <option value={CREATE_TOKEN}>+ 새 플레이리스트 만들기</option>
      </select>
      {showCreate && (
        <div style={createRowStyle}>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="플레이리스트 이름 (예: 겨울 컬렉션)"
            autoFocus
            style={inputStyle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleCreate();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeCreate();
              }
            }}
          />
          <Button
            size="sm"
            variant="primary"
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
          >
            {creating ? '...' : '만들기'}
          </Button>
          <Button size="sm" variant="ghost" onClick={closeCreate} disabled={creating}>
            취소
          </Button>
          {createError && <div style={createErrorStyle}>{createError}</div>}
        </div>
      )}
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--text-secondary, #444)',
};

const selectStyle: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 14,
  borderRadius: 6,
  border: '1px solid var(--border, #ddd)',
  background: '#fff',
  maxWidth: 320,
};

const errorStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  fontSize: 12,
  color: 'var(--warn, #d77)',
  background: 'var(--warn-soft, #fff7eb)',
  borderRadius: 6,
};

const createRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 200,
  padding: '8px 10px',
  fontSize: 14,
  borderRadius: 6,
  border: '1px solid var(--border, #ddd)',
};

const createErrorStyle: React.CSSProperties = {
  width: '100%',
  fontSize: 12,
  color: 'var(--danger, #d33)',
};
