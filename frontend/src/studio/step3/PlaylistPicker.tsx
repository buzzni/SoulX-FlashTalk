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
 *
 * Lives inside the wizard's .studio-root so we lean on the wizard's Button
 * primitive and the bridged tokens (--accent, --border, --bg) — visually
 * matches the rest of Step 3 with zero per-component overrides.
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
      <div
        className="flex items-center gap-2 px-3 py-2 text-xs rounded"
        style={{
          color: 'var(--warn)',
          background: 'var(--warn-soft)',
          border: '1px solid var(--warn)',
        }}
      >
        <Icon name="alert_circle" size={13} />
        <span className="flex-1">
          플레이리스트 목록을 못 불러왔어요 · 이번 영상은 미지정으로 저장됩니다
        </span>
        <Button size="sm" variant="ghost" onClick={() => loadList()}>
          다시 시도
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
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
        disabled={playlists === null}
        className="px-2.5 py-2 text-sm rounded max-w-xs disabled:opacity-60"
        style={{
          border: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          color: 'var(--text)',
        }}
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
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="플레이리스트 이름 (예: 겨울 컬렉션)"
            autoFocus
            className="flex-1 min-w-[200px] px-2.5 py-2 text-sm rounded"
            style={{
              border: '1px solid var(--border)',
              background: 'var(--bg-elev)',
              color: 'var(--text)',
            }}
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
          {createError && (
            <div
              className="w-full text-xs"
              style={{ color: 'var(--danger)' }}
            >
              {createError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
