/**
 * /results — grid of completed renders + playlist sidebar.
 *
 * Lane E of docs/playlist-feature-plan.md. Two-pane layout: sidebar with
 * 전체 / 미지정 / each playlist (alphabetical, plan decision #11), card grid
 * filters via /api/history?playlist_id=. Card [⋯] popover moves to another
 * playlist; sidebar item [⋯] renames/deletes. Cascade-on-delete sends videos
 * back to 미지정 (plan §5).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppHeader } from './AppHeader';
import { fetchJSON, humanizeError } from '../api/http';
import {
  createPlaylist,
  deletePlaylist,
  listPlaylists,
  moveResultToPlaylist,
  renamePlaylist,
  type Playlist,
  type PlaylistListResponse,
} from '../api/playlists';

interface HistoryItem {
  task_id: string;
  timestamp?: string;
  script_text?: string;
  host_image?: string;
  audio_source?: string;
  output_path?: string;
  file_size?: number;
  video_url?: string;
  generation_time?: number;
}

interface HistoryResponse {
  total: number;
  videos: HistoryItem[];
}

type Filter = 'all' | 'unassigned' | string; // string = playlist_id

export function ResultsListPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistListResponse | null>(null);
  const [playlistsError, setPlaylistsError] = useState<string | null>(null);

  // Bumping `epoch` triggers a refetch of both panes — used after every
  // mutation (create/rename/delete/move).
  const [epoch, setEpoch] = useState(0);
  const refresh = useCallback(() => setEpoch((n) => n + 1), []);

  // Load playlists.
  useEffect(() => {
    const ctl = new AbortController();
    setPlaylistsError(null);
    listPlaylists({ signal: ctl.signal })
      .then((r) => {
        const sorted = [...r.playlists].sort((a, b) =>
          a.name.localeCompare(b.name, 'ko'),
        );
        setPlaylists({ playlists: sorted, unassigned_count: r.unassigned_count });
      })
      .catch((e) => {
        if ((e as { name?: string })?.name === 'AbortError') return;
        setPlaylistsError(humanizeError(e));
      });
    return () => ctl.abort();
  }, [epoch]);

  // Load filtered history.
  useEffect(() => {
    const ctl = new AbortController();
    setItems(null);
    setHistoryError(null);
    const qs =
      filter === 'all' ? '' : `&playlist_id=${encodeURIComponent(filter)}`;
    fetchJSON<HistoryResponse>(`/api/history?limit=200${qs}`, {
      signal: ctl.signal,
      label: '내 영상 목록',
    })
      .then((r) => setItems(r.videos))
      .catch((e) => {
        if ((e as { name?: string })?.name === 'AbortError') return;
        setHistoryError(humanizeError(e));
      });
    return () => ctl.abort();
  }, [filter, epoch]);

  // If the currently-selected playlist gets deleted (this tab or another),
  // fall back to "전체". Trigger only when `playlists` changes — adding
  // `filter` to the deps would race the create-then-select flow, where
  // setFilter(new_id) runs before the refreshed playlists list has loaded.
  useEffect(() => {
    if (!playlists) return;
    if (filter === 'all' || filter === 'unassigned') return;
    const stillExists = playlists.playlists.some(
      (p) => p.playlist_id === filter,
    );
    if (!stillExists) setFilter('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlists]);

  const filterTitle = useMemo(() => {
    if (filter === 'all') return '내 영상들';
    if (filter === 'unassigned') return '미지정';
    return playlists?.playlists.find((p) => p.playlist_id === filter)?.name
      ?? '내 영상들';
  }, [filter, playlists]);

  return (
    <div style={pageStyle}>
      <AppHeader />
      <main style={mainStyle}>
        <div style={layoutStyle}>
          <PlaylistSidebar
            playlists={playlists}
            error={playlistsError}
            selected={filter}
            onSelect={setFilter}
            onChanged={refresh}
            onCreated={(p) => {
              refresh();
              setFilter(p.playlist_id);
            }}
          />
          <section style={contentStyle}>
            <div style={headerStyle}>
              <h1 style={titleStyle}>{filterTitle}</h1>
              {items !== null && (
                <span style={countStyle}>{items.length}개</span>
              )}
            </div>
            {historyError && <div style={errorStyle}>{historyError}</div>}
            {!historyError && items === null && (
              <div style={loadingStyle}>불러오는 중…</div>
            )}
            {!historyError && items !== null && items.length === 0 && (
              <div style={emptyStyle}>
                <p style={{ margin: 0, fontSize: 14, color: '#666' }}>
                  {filter === 'all'
                    ? '아직 만든 영상이 없어요.'
                    : '이 플레이리스트는 비어있어요.'}
                </p>
                {filter === 'all' && (
                  <Link to="/step/1" style={linkStyle}>
                    첫 영상 만들러 가기 →
                  </Link>
                )}
              </div>
            )}
            {!historyError && items !== null && items.length > 0 && (
              <div style={gridStyle}>
                {items.map((it) => (
                  <ResultCard
                    key={it.task_id}
                    item={it}
                    playlists={playlists?.playlists ?? []}
                    onMoved={refresh}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

// ── Sidebar ──────────────────────────────────────────────────────────

interface PlaylistSidebarProps {
  playlists: PlaylistListResponse | null;
  error: string | null;
  selected: Filter;
  onSelect: (f: Filter) => void;
  onChanged: () => void;
  onCreated: (p: Playlist) => void;
}

function PlaylistSidebar({
  playlists,
  error,
  selected,
  onSelect,
  onChanged,
  onCreated,
}: PlaylistSidebarProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const totalCount =
    (playlists?.unassigned_count ?? 0) +
    (playlists?.playlists ?? []).reduce((s, p) => s + p.video_count, 0);

  const closeCreate = () => {
    setCreating(false);
    setNewName('');
    setCreateError(null);
  };

  const submitCreate = async () => {
    const n = newName.trim();
    if (!n) return;
    setBusy(true);
    setCreateError(null);
    try {
      const p = await createPlaylist(n);
      closeCreate();
      onCreated(p);
    } catch (e) {
      setCreateError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside style={sidebarStyle}>
      {error && <div style={sidebarErrorStyle}>{error}</div>}
      <SidebarRow
        label="전체"
        count={totalCount}
        active={selected === 'all'}
        onClick={() => onSelect('all')}
      />
      <SidebarRow
        label="미지정"
        count={playlists?.unassigned_count ?? 0}
        active={selected === 'unassigned'}
        onClick={() => onSelect('unassigned')}
      />
      <hr style={hrStyle} />
      {(playlists?.playlists ?? []).map((p) => (
        <SidebarPlaylistRow
          key={p.playlist_id}
          playlist={p}
          active={selected === p.playlist_id}
          onSelect={() => onSelect(p.playlist_id)}
          onChanged={onChanged}
        />
      ))}
      <hr style={hrStyle} />
      {!creating ? (
        <button
          type="button"
          style={createBtnStyle}
          onClick={() => setCreating(true)}
        >
          + 새 플레이리스트
        </button>
      ) : (
        <div style={createWrapStyle}>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="이름 (예: 신상품)"
            autoFocus
            disabled={busy}
            style={createInputStyle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitCreate();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeCreate();
              }
            }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={submitCreate}
              disabled={busy || !newName.trim()}
              style={primaryBtnStyle}
            >
              만들기
            </button>
            <button
              type="button"
              onClick={closeCreate}
              disabled={busy}
              style={ghostBtnStyle}
            >
              취소
            </button>
          </div>
          {createError && <div style={inlineErrorStyle}>{createError}</div>}
        </div>
      )}
    </aside>
  );
}

interface SidebarRowProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

function SidebarRow({ label, count, active, onClick }: SidebarRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={active ? rowActiveStyle : rowStyle}
    >
      <span style={rowLabelStyle}>{label}</span>
      <span style={rowCountStyle}>{count}</span>
    </button>
  );
}

interface SidebarPlaylistRowProps {
  playlist: Playlist;
  active: boolean;
  onSelect: () => void;
  onChanged: () => void;
}

function SidebarPlaylistRow({
  playlist,
  active,
  onSelect,
  onChanged,
}: SidebarPlaylistRowProps) {
  const [hover, setHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(playlist.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close [⋯] popover on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const submitRename = async () => {
    const n = name.trim();
    if (!n || n === playlist.name) {
      setRenaming(false);
      setName(playlist.name);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await renamePlaylist(playlist.playlist_id, n);
      setRenaming(false);
      onChanged();
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = async () => {
    if (!window.confirm(
      `"${playlist.name}" 플레이리스트를 삭제할까요?\n` +
      `안에 있는 영상들은 미지정으로 옮겨집니다.`,
    )) {
      return;
    }
    setBusy(true);
    try {
      await deletePlaylist(playlist.playlist_id);
      onChanged();
    } catch (e) {
      setError(humanizeError(e));
      setBusy(false);
    }
  };

  if (renaming) {
    return (
      <div style={rowStyle}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          disabled={busy}
          style={renameInputStyle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setRenaming(false);
              setName(playlist.name);
            }
          }}
          onBlur={submitRename}
        />
        {error && <span style={inlineErrorStyle}>{error}</span>}
      </div>
    );
  }

  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        onClick={onSelect}
        style={active ? rowActiveStyle : rowStyle}
      >
        <span style={rowLabelStyle}>{playlist.name}</span>
        <span style={rowCountStyle}>{playlist.video_count}</span>
      </button>
      {(hover || menuOpen) && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          style={moreBtnStyle}
          aria-label="플레이리스트 옵션"
          title="옵션"
        >
          ⋯
        </button>
      )}
      {menuOpen && (
        <div ref={menuRef} style={popoverStyle}>
          <button
            type="button"
            style={popoverItemStyle}
            onClick={() => {
              setMenuOpen(false);
              setRenaming(true);
            }}
          >
            이름 변경
          </button>
          <button
            type="button"
            style={popoverItemDangerStyle}
            onClick={() => {
              setMenuOpen(false);
              submitDelete();
            }}
          >
            삭제
          </button>
        </div>
      )}
      {error && !renaming && <div style={inlineErrorStyle}>{error}</div>}
    </div>
  );
}

// ── Card ─────────────────────────────────────────────────────────────

interface ResultCardProps {
  item: HistoryItem;
  playlists: Playlist[];
  onMoved: () => void;
}

function ResultCard({ item, playlists, onMoved }: ResultCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const move = async (playlistId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await moveResultToPlaylist(item.task_id, playlistId);
      setMenuOpen(false);
      onMoved();
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  };

  const videoUrl = item.video_url || `/api/videos/${item.task_id}`;
  const ts = item.timestamp ? new Date(item.timestamp).toLocaleString('ko-KR') : '';
  const dur = item.generation_time ? `${Math.round(item.generation_time)}s` : '';
  const blurb = item.script_text || item.host_image || item.task_id.slice(0, 8);

  return (
    <div style={cardWrapStyle}>
      <Link to={`/result/${item.task_id}`} style={cardStyle}>
        <div style={thumbWrapStyle}>
          <video src={videoUrl} preload="metadata" muted style={thumbStyle} />
        </div>
        <div style={cardBodyStyle}>
          <div style={cardTitleStyle} title={blurb}>{blurb}</div>
          <div style={cardMetaStyle}>
            {ts}
            {dur && ` · ${dur}`}
          </div>
        </div>
      </Link>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        style={cardMoreBtnStyle}
        aria-label="옵션"
        title="옵션"
      >
        ⋯
      </button>
      {menuOpen && (
        <div ref={menuRef} style={cardPopoverStyle}>
          <div style={popoverHeaderStyle}>다른 플레이리스트로 이동</div>
          <button
            type="button"
            style={popoverItemStyle}
            onClick={() => move(null)}
            disabled={busy}
          >
            미지정
          </button>
          {playlists.map((p) => (
            <button
              key={p.playlist_id}
              type="button"
              style={popoverItemStyle}
              onClick={() => move(p.playlist_id)}
              disabled={busy}
            >
              {p.name}
            </button>
          ))}
          {error && <div style={inlineErrorStyle}>{error}</div>}
        </div>
      )}
    </div>
  );
}

// ── styles ───────────────────────────────────────────────────────────

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  background: '#f7f7fa',
  display: 'flex',
  flexDirection: 'column',
};

const mainStyle: React.CSSProperties = {
  flex: 1,
  padding: '24px 32px',
  maxWidth: 1280,
  width: '100%',
  margin: '0 auto',
};

const layoutStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '220px 1fr',
  gap: 24,
  alignItems: 'start',
};

const sidebarStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: 12,
  background: '#fff',
  borderRadius: 10,
  position: 'sticky',
  top: 16,
};

const sidebarErrorStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#b00020',
  padding: 6,
};

const contentStyle: React.CSSProperties = { minWidth: 0 };

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 10px',
  background: 'transparent',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 14,
  color: '#333',
  textAlign: 'left',
  width: '100%',
  position: 'relative',
};

const rowActiveStyle: React.CSSProperties = {
  ...rowStyle,
  background: '#eef2ff',
  fontWeight: 600,
  color: '#3553ff',
};

const rowLabelStyle: React.CSSProperties = {
  flex: 1,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  paddingRight: 30, // leave room for the [⋯] button
};

const rowCountStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#888',
  fontVariantNumeric: 'tabular-nums',
};

const moreBtnStyle: React.CSSProperties = {
  position: 'absolute',
  right: 8,
  top: '50%',
  transform: 'translateY(-50%)',
  width: 24,
  height: 24,
  background: 'rgba(255,255,255,0.9)',
  border: '1px solid #ddd',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const popoverStyle: React.CSSProperties = {
  position: 'absolute',
  right: 4,
  top: '100%',
  marginTop: 4,
  background: '#fff',
  border: '1px solid #ddd',
  borderRadius: 8,
  boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
  zIndex: 10,
  minWidth: 140,
  display: 'flex',
  flexDirection: 'column',
  padding: 4,
};

const popoverItemStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: '8px 10px',
  fontSize: 13,
  textAlign: 'left',
  cursor: 'pointer',
  borderRadius: 4,
  color: '#333',
};

const popoverItemDangerStyle: React.CSSProperties = {
  ...popoverItemStyle,
  color: '#b00020',
};

const popoverHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#888',
  padding: '6px 10px 4px',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};

const hrStyle: React.CSSProperties = {
  border: 'none',
  borderTop: '1px solid #eee',
  margin: '8px 4px',
};

const createBtnStyle: React.CSSProperties = {
  ...rowStyle,
  color: '#3553ff',
  fontWeight: 600,
};

const createWrapStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '6px 8px',
};

const createInputStyle: React.CSSProperties = {
  padding: '6px 8px',
  fontSize: 13,
  borderRadius: 4,
  border: '1px solid #ddd',
};

const renameInputStyle: React.CSSProperties = {
  flex: 1,
  padding: '6px 8px',
  fontSize: 13,
  borderRadius: 4,
  border: '1px solid #3553ff',
};

const primaryBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: '5px 8px',
  fontSize: 12,
  background: '#3553ff',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
};

const ghostBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: '5px 8px',
  fontSize: 12,
  background: 'transparent',
  color: '#666',
  border: '1px solid #ddd',
  borderRadius: 4,
  cursor: 'pointer',
};

const inlineErrorStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#b00020',
  padding: '4px 8px',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 12,
  marginBottom: 16,
};

const titleStyle: React.CSSProperties = { margin: 0, fontSize: 22, fontWeight: 700 };
const countStyle: React.CSSProperties = { fontSize: 14, color: '#666' };

const errorStyle: React.CSSProperties = {
  padding: 16,
  background: '#fff1f1',
  color: '#b00020',
  borderRadius: 8,
};

const loadingStyle: React.CSSProperties = {
  padding: 16,
  color: '#666',
};

const emptyStyle: React.CSSProperties = {
  padding: '48px 16px',
  textAlign: 'center',
  background: '#fff',
  borderRadius: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  alignItems: 'center',
};

const linkStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: '#3553ff',
  textDecoration: 'none',
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: 16,
};

const cardWrapStyle: React.CSSProperties = {
  position: 'relative',
};

const cardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  background: '#fff',
  borderRadius: 10,
  overflow: 'hidden',
  textDecoration: 'none',
  color: 'inherit',
  boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
};

const cardMoreBtnStyle: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  width: 28,
  height: 28,
  background: 'rgba(0,0,0,0.55)',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const cardPopoverStyle: React.CSSProperties = {
  position: 'absolute',
  top: 40,
  right: 8,
  background: '#fff',
  border: '1px solid #ddd',
  borderRadius: 8,
  boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  zIndex: 10,
  minWidth: 160,
  maxHeight: 320,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  padding: 4,
};

const thumbWrapStyle: React.CSSProperties = {
  width: '100%',
  aspectRatio: '16 / 9',
  background: '#000',
  overflow: 'hidden',
};

const thumbStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
};

const cardBodyStyle: React.CSSProperties = { padding: 12 };

const cardTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  marginBottom: 4,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const cardMetaStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#888',
};
