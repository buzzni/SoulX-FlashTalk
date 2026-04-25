/**
 * /results — grid of completed renders + playlist sidebar.
 *
 * Lane E of docs/playlist-feature-plan.md. Two-pane layout: sidebar with
 * 전체 / 미지정 / each playlist (alphabetical, plan decision #11), card
 * grid filters via /api/history?playlist_id=. Card [⋯] popover moves to
 * another playlist; sidebar item [⋯] renames/deletes. Cascade-on-delete
 * sends videos back to 미지정 (plan §5).
 *
 * Styling — Tailwind utility classes against the design tokens defined in
 * `frontend/src/index.css`. Sidebar uses `--color-sidebar-*`, popovers
 * use the `panel-glass` utility, rows use `panel-row`, surfaces use
 * `surface-base`. No inline hex colors.
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
  // `filter` to the deps would race the create-then-select flow.
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
    <div className="min-h-screen flex flex-col bg-background">
      <AppHeader />
      <main className="flex-1 px-4 md:px-6 py-6 max-w-[1280px] w-full mx-auto">
        <div className="grid gap-4 md:gap-6 items-start grid-cols-1 md:grid-cols-[minmax(220px,240px)_minmax(0,1fr)]">
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
          <section className="min-w-0">
            <div className="flex items-baseline gap-3 mb-4">
              <h1 className="m-0 text-[22px] font-bold tracking-tight">{filterTitle}</h1>
              {items !== null && (
                <span className="text-sm text-muted-foreground tabular-nums">
                  {items.length}개
                </span>
              )}
            </div>
            {historyError && (
              <div className="px-4 py-3 rounded-md bg-[hsl(0_90%_96%)] text-destructive border border-destructive/30">
                {historyError}
              </div>
            )}
            {!historyError && items === null && (
              <div className="px-4 py-3 text-muted-foreground">불러오는 중…</div>
            )}
            {!historyError && items !== null && items.length === 0 && (
              <div className="flex flex-col items-center gap-3 py-12 px-4 surface-base rounded-xl text-center animate-fade-in">
                <p className="m-0 text-sm text-muted-foreground">
                  {filter === 'all'
                    ? '아직 만든 영상이 없어요.'
                    : '이 플레이리스트는 비어있어요.'}
                </p>
                {filter === 'all' && (
                  <Link
                    to="/step/1"
                    className="text-sm font-semibold text-primary no-underline hover:underline"
                  >
                    첫 영상 만들러 가기 →
                  </Link>
                )}
              </div>
            )}
            {!historyError && items !== null && items.length > 0 && (
              <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
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
    <aside className="flex flex-col gap-1 p-3 rounded-lg bg-sidebar-background border border-sidebar-border md:sticky md:top-4">
      {error && (
        <div className="px-2 py-1.5 text-xs text-destructive">{error}</div>
      )}
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
      <hr className="border-0 border-t border-sidebar-border my-2" />
      {(playlists?.playlists ?? []).map((p) => (
        <SidebarPlaylistRow
          key={p.playlist_id}
          playlist={p}
          active={selected === p.playlist_id}
          onSelect={() => onSelect(p.playlist_id)}
          onChanged={onChanged}
        />
      ))}
      <hr className="border-0 border-t border-sidebar-border my-2" />
      {!creating ? (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex items-center justify-between w-full text-left px-2.5 py-2 rounded text-sm font-semibold text-primary transition-colors hover:bg-accent/40 cursor-pointer"
        >
          + 새 플레이리스트
        </button>
      ) : (
        <div className="flex flex-col gap-1.5 px-1.5 py-1.5">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="이름 (예: 신상품)"
            autoFocus
            disabled={busy}
            className="px-2 py-1.5 text-[13px] rounded border border-input bg-card disabled:opacity-60 transition-colors focus:border-primary"
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
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={submitCreate}
              disabled={busy || !newName.trim()}
              className="flex-1 px-2 py-1.5 text-xs font-semibold rounded bg-primary text-primary-foreground transition-colors hover:bg-[var(--color-brand-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              만들기
            </button>
            <button
              type="button"
              onClick={closeCreate}
              disabled={busy}
              className="flex-1 px-2 py-1.5 text-xs rounded border border-input bg-card text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-60 cursor-pointer"
            >
              취소
            </button>
          </div>
          {createError && (
            <div className="text-[11px] text-destructive">{createError}</div>
          )}
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
  const base =
    'flex items-center justify-between w-full text-left px-2.5 py-2 rounded text-sm transition-colors cursor-pointer';
  const variant = active
    ? 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold'
    : 'text-sidebar-foreground hover:bg-accent/40';
  return (
    <button type="button" onClick={onClick} className={`${base} ${variant}`}>
      <span className="truncate pr-2">{label}</span>
      <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
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
      <div className="px-1.5">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          disabled={busy}
          className="w-full px-2 py-1.5 text-[13px] rounded border border-primary bg-card disabled:opacity-60"
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
        {error && (
          <div className="text-[11px] text-destructive px-1 pt-1">{error}</div>
        )}
      </div>
    );
  }

  const rowBase =
    'flex items-center justify-between w-full text-left pl-2.5 pr-9 py-2 rounded text-sm transition-colors cursor-pointer';
  const rowVariant = active
    ? 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold'
    : 'text-sidebar-foreground hover:bg-accent/40';

  return (
    <div
      className="relative"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button type="button" onClick={onSelect} className={`${rowBase} ${rowVariant}`}>
        <span className="truncate pr-2">{playlist.name}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {playlist.video_count}
        </span>
      </button>
      {(hover || menuOpen) && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          aria-label="플레이리스트 옵션"
          title="옵션"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 grid place-items-center w-6 h-6 rounded text-muted-foreground bg-card/90 border border-border hover:border-primary hover:text-foreground transition-colors cursor-pointer"
        >
          ⋯
        </button>
      )}
      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-1 top-full mt-1 z-20 min-w-[140px] panel-glass p-1 flex flex-col animate-fade-in"
        >
          <PopoverItem
            onClick={() => {
              setMenuOpen(false);
              setRenaming(true);
            }}
          >
            이름 변경
          </PopoverItem>
          <PopoverItem
            variant="danger"
            onClick={() => {
              setMenuOpen(false);
              submitDelete();
            }}
          >
            삭제
          </PopoverItem>
        </div>
      )}
      {error && !renaming && (
        <div className="text-[11px] text-destructive px-2 pt-1">{error}</div>
      )}
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
    <div className="relative group">
      <Link
        to={`/result/${item.task_id}`}
        className="flex flex-col rounded-lg surface-base overflow-hidden no-underline text-foreground shadow-[0_2px_8px_rgba(0,0,0,0.04)] transition-shadow hover:shadow-[0_6px_18px_rgba(0,0,0,0.08)]"
      >
        <div className="w-full aspect-video bg-foreground overflow-hidden">
          <video src={videoUrl} preload="metadata" muted className="block w-full h-full object-cover" />
        </div>
        <div className="p-3">
          <div className="text-sm font-semibold mb-1 truncate" title={blurb}>{blurb}</div>
          <div className="text-xs text-muted-foreground">
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
        aria-label="옵션"
        title="옵션"
        className="absolute top-2 right-2 grid place-items-center w-7 h-7 rounded-md bg-foreground/55 text-card text-base leading-none cursor-pointer transition-colors hover:bg-foreground/75"
      >
        ⋯
      </button>
      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute top-10 right-2 z-20 min-w-[160px] max-h-[320px] overflow-y-auto panel-glass p-1 flex flex-col animate-fade-in"
        >
          <div className="text-[11px] font-semibold uppercase tracking-widest px-2.5 pt-1.5 pb-1 text-muted-foreground">
            다른 플레이리스트로 이동
          </div>
          <PopoverItem onClick={() => move(null)} disabled={busy}>
            미지정
          </PopoverItem>
          {playlists.map((p) => (
            <PopoverItem
              key={p.playlist_id}
              onClick={() => move(p.playlist_id)}
              disabled={busy}
            >
              {p.name}
            </PopoverItem>
          ))}
          {error && (
            <div className="text-[11px] text-destructive px-2 pt-1">{error}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── shared popover item ──────────────────────────────────────────────

interface PopoverItemProps {
  onClick: () => void;
  disabled?: boolean;
  variant?: 'default' | 'danger';
  children: React.ReactNode;
}

function PopoverItem({
  onClick,
  disabled = false,
  variant = 'default',
  children,
}: PopoverItemProps) {
  const color = variant === 'danger' ? 'text-destructive' : 'text-foreground';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`text-left px-2.5 py-2 text-[13px] rounded transition-colors hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${color}`}
    >
      {children}
    </button>
  );
}
