/**
 * /results — 라이브러리. 완료/실패/취소 영상 + 플레이리스트.
 *
 * 두 줄 chip strip (playlist + status) + sort 부재 (Phase 2 deferred per
 * docs/results-page-overhaul-plan.md decision #15) + page-based pagination
 * (decision #16). URL state via useSearchParams so filter/page deep-links
 * survive reload + browser back/forward.
 */
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { MoreHorizontal, Plus, Play, RotateCw, Trash2 } from 'lucide-react';
import { AppLayout } from './AppLayout';
import { EmptyState } from '../components/empty-state';
import { Pagination } from '../components/pagination';
import { videoTitle, formatCompactDate, outputsPathToUrl } from '../lib/format';
import { startNewVideo } from '../lib/wizardNav';
import { cn } from '@/lib/utils';
import { humanizeError } from '../api/http';
import { deleteResult } from '../api/result';
import {
  fetchHistoryPage,
  fetchHistoryCounts,
  type HistoryStatus,
  type HistoryCounts,
} from '../api/history';
import { ConfirmModal } from '../components/confirm-modal';
import {
  createPlaylist,
  deletePlaylist,
  listPlaylists,
  moveResultToPlaylist,
  renamePlaylist,
  type Playlist,
  type PlaylistListResponse,
} from '../api/playlists';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
interface HistoryItem {
  task_id: string;
  type?: 'generate' | 'conversation' | null;
  status?: 'completed' | 'error' | 'cancelled' | null;
  public_error?: string | null;
  timestamp?: string | null;
  /** Step-2 composite still (the FINAL frame FlashTalk animates).
   * Backend `_project_history_row` exposes it from `params.host_image`.
   * Used as the card thumbnail for failed/cancelled tasks (no video to
   * play) and as the poster image for completed cards. */
  host_image?: string | null;
  output_path?: string | null;
  file_size?: number | null;
  video_url?: string;
  generation_time?: number | null;
}

type PlaylistFilter = 'all' | 'unassigned' | string;

const PAGE_SIZE = 24;

const VALID_STATUSES = new Set<HistoryStatus>(['all', 'completed', 'error', 'cancelled']);

function parseStatus(raw: string | null): HistoryStatus {
  return raw && VALID_STATUSES.has(raw as HistoryStatus) ? (raw as HistoryStatus) : 'all';
}

function parsePage(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export function ResultsListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // URL-backed state.
  const playlistFilter: PlaylistFilter = searchParams.get('playlist_id') || 'all';
  const statusFilter: HistoryStatus = parseStatus(searchParams.get('status'));
  const page = parsePage(searchParams.get('page'));

  const updateParams = useCallback(
    (updates: Record<string, string | null>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(updates)) {
            if (v === null || v === '') next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );

  const setPlaylistFilter = useCallback(
    (next: PlaylistFilter) => {
      updateParams({
        playlist_id: next === 'all' ? null : next,
        page: null,        // reset page on filter change
      });
    },
    [updateParams],
  );

  const setStatusFilter = useCallback(
    (next: HistoryStatus) => {
      updateParams({ status: next === 'all' ? null : next, page: null });
    },
    [updateParams],
  );

  const setPage = useCallback(
    (next: number) => {
      updateParams({ page: next === 1 ? null : String(next) });
    },
    [updateParams],
  );

  // Fetched data.
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [counts, setCounts] = useState<HistoryCounts | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistListResponse | null>(null);
  const [playlistsError, setPlaylistsError] = useState<string | null>(null);

  const [epoch, setEpoch] = useState(0);
  const refresh = useCallback(() => setEpoch((n) => n + 1), []);

  // Playlists fetch (independent of filter changes).
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

  // History list fetch — refires on any filter / page change.
  useEffect(() => {
    const ctl = new AbortController();
    setItems(null);
    setHistoryError(null);
    fetchHistoryPage(
      {
        status: statusFilter,
        offset: (page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
        playlist_id: playlistFilter === 'all' ? undefined : playlistFilter,
      },
      { signal: ctl.signal },
    )
      .then((r) => {
        setItems((r.videos ?? []) as HistoryItem[]);
        setTotal(r.total);
      })
      .catch((e) => {
        if ((e as { name?: string })?.name === 'AbortError') return;
        setHistoryError(humanizeError(e));
      });
    return () => ctl.abort();
  }, [statusFilter, playlistFilter, page, epoch]);

  // Counts fetch — depends on playlist scope only (not status/page).
  useEffect(() => {
    const ctl = new AbortController();
    fetchHistoryCounts(
      playlistFilter === 'all' ? undefined : playlistFilter,
      { signal: ctl.signal },
    )
      .then((c) => setCounts(c))
      .catch((e) => {
        if ((e as { name?: string })?.name === 'AbortError') return;
        // Counts failure is non-fatal — chips show "—" placeholders.
        setCounts(null);
      });
    return () => ctl.abort();
  }, [playlistFilter, epoch]);

  // Stale playlist_id (deleted in another tab) → fall back to "all".
  useEffect(() => {
    if (!playlists) return;
    if (playlistFilter === 'all' || playlistFilter === 'unassigned') return;
    const stillExists = playlists.playlists.some(
      (p) => p.playlist_id === playlistFilter,
    );
    if (!stillExists) setPlaylistFilter('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlists]);

  // Beyond-last-page snap (per plan §10 failure mode).
  useEffect(() => {
    if (items === null) return;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > totalPages) setPage(totalPages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, total]);

  const filterTitle = useMemo(() => {
    const playlistName =
      playlistFilter === 'all'
        ? '내 영상들'
        : playlistFilter === 'unassigned'
          ? '미지정'
          : (playlists?.playlists.find((p) => p.playlist_id === playlistFilter)?.name
              ?? '내 영상들');
    return playlistName;
  }, [playlistFilter, playlists]);

  const playlistTotalCount =
    (playlists?.unassigned_count ?? 0) +
    (playlists?.playlists ?? []).reduce((s, p) => s + p.video_count, 0);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AppLayout active="results">
      <div className="px-6 md:px-12 pt-12 md:pt-16 pb-16 max-w-[1280px] animate-rise">
        {/* Page heading */}
        <div className="mb-6">
          <div className="text-sm-tight text-muted-foreground mb-1.5">라이브러리</div>
          <h1 className="headline-section m-0">{filterTitle}</h1>
          <p className="m-0 mt-1 text-sm-tight text-muted-foreground">
            {total}개의 영상
          </p>
        </div>

        {/* Row 1: Playlist chips */}
        <PlaylistChips
          playlists={playlists}
          totalCount={playlistTotalCount}
          selected={playlistFilter}
          onSelect={setPlaylistFilter}
          onChanged={refresh}
          onCreated={(p) => {
            refresh();
            setPlaylistFilter(p.playlist_id);
          }}
          error={playlistsError}
        />

        {/* Row 2: Status chips. Mobile: horizontal-scroll snap-x. */}
        <div className="mt-3 flex items-center gap-2 overflow-x-auto scrollbar-none snap-x">
          <StatusChip
            label="전체"
            count={counts?.all}
            active={statusFilter === 'all'}
            onClick={() => setStatusFilter('all')}
          />
          <StatusChip
            label="완료"
            count={counts?.completed}
            active={statusFilter === 'completed'}
            onClick={() => setStatusFilter('completed')}
            tone="success"
          />
          <StatusChip
            label="실패"
            count={counts?.error}
            active={statusFilter === 'error'}
            onClick={() => setStatusFilter('error')}
            tone="error"
          />
          <StatusChip
            label="취소"
            count={counts?.cancelled}
            active={statusFilter === 'cancelled'}
            onClick={() => setStatusFilter('cancelled')}
            tone="muted"
          />
        </div>

        {historyError && (
          <div className="mt-4 px-4 py-3 text-sm-tight bg-destructive-soft text-destructive border border-destructive/30 rounded-md">
            {historyError}
          </div>
        )}

        {/* Loading: skeleton card grid (decision §13.5) */}
        {!historyError && items === null && (
          <div className="mt-6 grid gap-4 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
            {Array.from({ length: 8 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        )}

        {/* Empty state per (playlistFilter, statusFilter) */}
        {!historyError && items !== null && items.length === 0 && (
          <div className="mt-6 surface-card animate-fade-in">
            <EmptyDispatch
              playlistFilter={playlistFilter}
              statusFilter={statusFilter}
              onStartNew={() => startNewVideo(navigate)}
              onShowAll={() => setStatusFilter('all')}
            />
          </div>
        )}

        {/* Grid */}
        {!historyError && items !== null && items.length > 0 && (
          <>
            <div className="mt-6 grid gap-4 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
              {items.map((it) => (
                <ResultCard
                  key={it.task_id}
                  item={it}
                  playlists={playlists?.playlists ?? []}
                  onMoved={refresh}
                />
              ))}
            </div>
            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          </>
        )}
      </div>
    </AppLayout>
  );
}

// ── Empty state per (playlist, status) — decision §13.9 ─────────────

interface EmptyDispatchProps {
  playlistFilter: PlaylistFilter;
  statusFilter: HistoryStatus;
  onStartNew: () => void;
  onShowAll: () => void;
}

function EmptyDispatch({ playlistFilter, statusFilter, onStartNew, onShowAll }: EmptyDispatchProps) {
  const inPlaylist = playlistFilter !== 'all';
  if (inPlaylist) {
    return (
      <EmptyState
        kind="no-playlist-items"
        title="이 필터로는 영상이 없어요"
        description={
          statusFilter === 'all'
            ? '결과 카드의 ⋯ 메뉴에서 이 플레이리스트로 옮겨보세요.'
            : '다른 상태의 영상이 있는지 확인해 보세요.'
        }
        action={
          statusFilter !== 'all' ? (
            <button
              type="button"
              onClick={onShowAll}
              className="text-primary text-sm-tight font-semibold hover:underline cursor-pointer"
            >
              전체 보기 →
            </button>
          ) : undefined
        }
      />
    );
  }
  if (statusFilter === 'completed') {
    return (
      <EmptyState
        kind="no-videos"
        title="아직 완성된 영상이 없어요"
        description="진행 중인 작업이 있는지 확인해 보세요."
        action={
          <button
            type="button"
            onClick={onStartNew}
            className="text-primary text-sm-tight font-semibold hover:underline cursor-pointer"
          >
            첫 영상 만들러 가기 →
          </button>
        }
      />
    );
  }
  if (statusFilter === 'error') {
    return (
      <EmptyState
        kind="no-videos"
        title="실패한 영상이 없어요 🎉"
        description="모든 영상이 잘 만들어졌어요."
      />
    );
  }
  if (statusFilter === 'cancelled') {
    return (
      <EmptyState
        kind="no-videos"
        title="취소한 영상이 없어요"
        description=""
      />
    );
  }
  return (
    <EmptyState
      kind="no-videos"
      title="아직 만든 영상이 없어요"
      description="첫 영상을 만들어 라이브러리를 채워보세요."
      action={
        <button
          type="button"
          onClick={onStartNew}
          className="text-primary text-sm-tight font-semibold hover:underline cursor-pointer"
        >
          첫 영상 만들러 가기 →
        </button>
      }
    />
  );
}

// ── Status filter chip ──────────────────────────────────────────────

interface StatusChipProps {
  label: string;
  count: number | undefined;
  active: boolean;
  onClick: () => void;
  tone?: 'default' | 'success' | 'error' | 'muted';
}

function StatusChip({ label, count, active, onClick, tone = 'default' }: StatusChipProps) {
  const dot = tone === 'success'
    ? 'bg-success'
    : tone === 'error'
      ? 'bg-destructive'
      : tone === 'muted'
        ? 'bg-muted-foreground'
        : null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer shrink-0 snap-start',
        active
          ? 'bg-foreground text-background'
          : 'bg-card border border-border text-ink-2 hover:border-rule-strong hover:text-foreground',
      )}
    >
      {dot && (
        <span aria-hidden className={cn('size-1.5 rounded-full', dot, active && 'opacity-90')} />
      )}
      <span>{label}</span>
      <span className={cn('text-2xs tabular-nums', active ? 'text-background/70' : 'text-muted-foreground')}>
        {count ?? '—'}
      </span>
    </button>
  );
}

// ── Skeleton card (loading state, decision §13.5) ───────────────────

function SkeletonCard() {
  return (
    <div className="surface-card overflow-hidden">
      <div className="w-full aspect-video skeleton-shimmer" />
      <div className="p-3.5">
        <div className="h-4 w-3/4 rounded bg-surface-2 animate-pulse mb-2" />
        <div className="h-3 w-1/2 rounded bg-surface-2 animate-pulse" />
      </div>
    </div>
  );
}

// ── Playlist chips strip ─────────────────────────────────────────────

interface PlaylistChipsProps {
  playlists: PlaylistListResponse | null;
  totalCount: number;
  selected: PlaylistFilter;
  onSelect: (f: PlaylistFilter) => void;
  onChanged: () => void;
  onCreated: (p: Playlist) => void;
  error: string | null;
}

function PlaylistChips({
  playlists,
  totalCount,
  selected,
  onSelect,
  onChanged,
  onCreated,
  error,
}: PlaylistChipsProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      toast.success(`'${n}' 플레이리스트를 만들었어요`);
      onCreated(p);
    } catch (e) {
      setCreateError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {error && (
        <div className="text-xs text-destructive">{error}</div>
      )}
      <FilterChip
        label="전체"
        count={totalCount}
        active={selected === 'all'}
        onClick={() => onSelect('all')}
      />
      <FilterChip
        label="미지정"
        count={playlists?.unassigned_count ?? 0}
        active={selected === 'unassigned'}
        onClick={() => onSelect('unassigned')}
      />
      {(playlists?.playlists ?? []).length > 0 && (
        <span className="mx-1 w-px h-5 bg-border" aria-hidden />
      )}
      {(playlists?.playlists ?? []).map((p) => (
        <PlaylistChip
          key={p.playlist_id}
          playlist={p}
          active={selected === p.playlist_id}
          onSelect={() => onSelect(p.playlist_id)}
          onChanged={onChanged}
        />
      ))}
      {!creating ? (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full border border-dashed border-rule-strong text-muted-foreground text-xs font-medium hover:border-primary hover:text-primary transition-colors cursor-pointer"
        >
          <Plus className="size-3.5" />
          <span>새 플레이리스트</span>
        </button>
      ) : (
        <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border border-primary bg-card">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="이름 (예: 신상품)"
            autoFocus
            disabled={busy}
            className="text-xs bg-transparent border-0 outline-none px-1 w-36 disabled:opacity-60"
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
          <button
            type="button"
            onClick={submitCreate}
            disabled={busy || !newName.trim()}
            className="px-2.5 py-0.5 text-2xs font-semibold rounded-full bg-primary text-primary-foreground disabled:opacity-50 cursor-pointer"
          >
            만들기
          </button>
          <button
            type="button"
            onClick={closeCreate}
            disabled={busy}
            className="px-2 py-0.5 text-2xs text-muted-foreground hover:text-foreground cursor-pointer"
          >
            취소
          </button>
        </div>
      )}
      {createError && (
        <div className="w-full text-2xs text-destructive mt-1">{createError}</div>
      )}
    </div>
  );
}

interface FilterChipProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

function FilterChip({ label, count, active, onClick }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer',
        active
          ? 'bg-foreground text-background'
          : 'bg-card border border-border text-ink-2 hover:border-rule-strong hover:text-foreground',
      )}
    >
      <span>{label}</span>
      <span className={cn('text-2xs tabular-nums', active ? 'text-background/70' : 'text-muted-foreground')}>
        {count}
      </span>
    </button>
  );
}

interface PlaylistChipProps {
  playlist: Playlist;
  active: boolean;
  onSelect: () => void;
  onChanged: () => void;
}

function PlaylistChip({ playlist, active, onSelect, onChanged }: PlaylistChipProps) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(playlist.name);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const submitRename = async () => {
    const n = name.trim();
    if (!n || n === playlist.name) {
      setRenaming(false);
      setName(playlist.name);
      return;
    }
    setBusy(true);
    try {
      await renamePlaylist(playlist.playlist_id, n);
      setRenaming(false);
      toast.success(`이름을 '${n}' 으로 바꿨어요`);
      onChanged();
    } catch (e) {
      setName(playlist.name);
      setRenaming(false);
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  };

  const askDelete = () => setConfirmingDelete(true);
  const submitDelete = async () => {
    setConfirmingDelete(false);
    setBusy(true);
    try {
      await deletePlaylist(playlist.playlist_id);
      toast.success(`'${playlist.name}' 플레이리스트를 삭제했어요`);
      onChanged();
    } catch (e) {
      toast.error(humanizeError(e));
      setBusy(false);
    }
  };

  if (renaming) {
    return (
      <div className="inline-flex items-center px-2 py-1 rounded-full border border-primary bg-card">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          disabled={busy}
          className="text-xs bg-transparent border-0 outline-none px-1 w-32"
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submitRename(); }
            else if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); setName(playlist.name); }
          }}
          onBlur={submitRename}
        />
      </div>
    );
  }

  return (
    <div className="inline-flex items-center group">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn(
          'inline-flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-l-full text-xs font-medium transition-colors cursor-pointer border',
          active
            ? 'bg-foreground text-background border-foreground'
            : 'bg-card border-border text-ink-2 hover:border-rule-strong hover:text-foreground',
        )}
      >
        <span>{playlist.name}</span>
        <span className={cn('text-2xs tabular-nums', active ? 'text-background/70' : 'text-muted-foreground')}>
          {playlist.video_count}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${playlist.name} 옵션`}
            className={cn(
              'inline-flex items-center justify-center w-7 h-[30px] rounded-r-full border border-l-0 transition-colors cursor-pointer',
              active
                ? 'bg-foreground text-background border-foreground hover:bg-foreground/85'
                : 'bg-card border-border text-muted-foreground hover:text-foreground hover:border-rule-strong',
            )}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[140px]">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            이름 변경
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={askDelete} variant="destructive">
            삭제
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmModal
        open={confirmingDelete}
        title="플레이리스트를 삭제할까요?"
        description={
          <p className="m-0 leading-relaxed">
            <b>{playlist.name}</b>
            <br />
            <span className="text-tertiary">
              안에 있는 영상들은 미지정으로 옮겨져요.
            </span>
          </p>
        }
        confirmLabel="삭제"
        variant="danger"
        busy={busy}
        onConfirm={submitDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}

// ── ResultCard with status variants (decision §13.4) ─────────────────

interface ResultCardProps {
  item: HistoryItem;
  playlists: Playlist[];
  onMoved: () => void;
}

function ResultCard({ item, playlists, onMoved }: ResultCardProps) {
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const status = item.status ?? 'completed';
  const isCompleted = status === 'completed';
  const isError = status === 'error';
  const isCancelled = status === 'cancelled';

  const move = async (playlistId: string | null, playlistName: string) => {
    setBusy(true);
    try {
      await moveResultToPlaylist(item.task_id, playlistId);
      toast.success(`'${playlistName}' 으로 옮겼어요`);
      onMoved();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = async () => {
    setConfirmingDelete(false);
    setBusy(true);
    try {
      await deleteResult(item.task_id);
      toast.success('영상을 삭제했어요');
      onMoved();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  };

  // Hover preview only on completed cards.
  const onMouseEnter = () => {
    if (!isCompleted) return;
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = 0;
    v.play().catch(() => {});
  };
  const onMouseLeave = () => {
    if (!isCompleted) return;
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
  };

  const videoUrl = item.video_url || `/api/videos/${item.task_id}`;
  const compositeUrl = outputsPathToUrl(item.host_image);
  const title = videoTitle(item);
  const ts = formatCompactDate(item.timestamp);

  return (
    <div className="relative group">
      <Link
        to={`/result/${item.task_id}`}
        className={cn(
          'surface-card overflow-hidden no-underline text-foreground transition-all block',
          'hover:translate-y-[-1px] hover:shadow-[var(--shadow-1)] hover:border-rule-strong',
        )}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        <div className="relative w-full aspect-video bg-foreground overflow-hidden">
          {isCompleted ? (
            // Completed: hover-play video, fall back to composite still as
            // poster while metadata loads. object-contain preserves the
            // source's true aspect ratio (portrait videos letterbox cleanly
            // against the black surface).
            <video
              ref={videoRef}
              src={videoUrl}
              poster={compositeUrl ?? undefined}
              preload="metadata"
              muted
              playsInline
              loop
              className="block w-full h-full object-contain"
            />
          ) : compositeUrl ? (
            // Failed/cancelled: show the step-2 composite still (the final
            // frame FlashTalk would have animated). Dimmed so it reads as
            // "not a finished video" without becoming an opaque gradient.
            <img
              src={compositeUrl}
              alt=""
              aria-hidden
              loading="lazy"
              className="block w-full h-full object-contain opacity-65"
            />
          ) : (
            // No composite still recorded — fall back to the prior
            // gradient surface so the grid stays uniform.
            <div
              aria-hidden
              className="block w-full h-full bg-gradient-to-br from-surface-2 to-bg-sunken opacity-70"
            />
          )}
          <span
            className={cn(
              'absolute top-2 left-2',
              isCompleted && 'pill-success',
              isError && 'pill-error',
              isCancelled && 'pill-muted',
            )}
          >
            {isCompleted ? '완료' : isError ? '실패' : '취소'}
          </span>
          {isCompleted && (
            <span className="absolute inset-0 grid place-items-center pointer-events-none opacity-0 group-hover:opacity-0 [&_.idle]:opacity-100 group-hover:[&_.idle]:opacity-0">
              <span className="idle grid place-items-center size-10 rounded-full bg-background/85 text-foreground transition-opacity">
                <Play className="size-4" fill="currentColor" />
              </span>
            </span>
          )}
        </div>
        <div className="p-3.5">
          <div className="font-semibold text-sm tracking-tight line-clamp-1 mb-1" title={title}>
            {title}
          </div>
          <div className="text-2xs text-muted-foreground tabular-nums">
            {ts}
          </div>
        </div>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="옵션"
            title="플레이리스트 이동, 옵션"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            disabled={busy}
            className="absolute top-2 right-2 grid place-items-center size-7 rounded-md bg-foreground/65 text-background cursor-pointer transition-colors hover:bg-foreground/85 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[180px] max-h-[320px] overflow-y-auto">
          {isError && (
            <>
              <DropdownMenuItem
                onSelect={() => {
                  // "다시 만들기" — route to wizard with the failed task as a
                  // template. Existing /result/:id surfaces the same retry
                  // path; we just shortcut it from the grid.
                  window.location.href = `/result/${item.task_id}`;
                }}
              >
                <RotateCw className="size-3.5 mr-1.5" />
                다시 만들기
              </DropdownMenuItem>
              <div className="my-1 h-px bg-border" />
            </>
          )}
          <DropdownMenuLabel className="text-2xs font-semibold text-muted-foreground">
            플레이리스트로 이동
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => move(null, '미지정')}>미지정</DropdownMenuItem>
          {playlists.map((p) => (
            <DropdownMenuItem
              key={p.playlist_id}
              onSelect={() => move(p.playlist_id, p.name)}
            >
              {p.name}
            </DropdownMenuItem>
          ))}
          <div className="my-1 h-px bg-border" />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirmingDelete(true)}
          >
            <Trash2 className="size-3.5 mr-1.5" />
            삭제
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmModal
        open={confirmingDelete}
        title="이 영상을 삭제할까요?"
        description={
          <p className="m-0 leading-relaxed">
            <b>{title}</b>
            <br />
            <span className="text-tertiary">
              {isCompleted
                ? '영상 파일과 결과 정보가 모두 삭제돼요. 되돌릴 수 없어요.'
                : '결과 기록이 삭제돼요. 되돌릴 수 없어요.'}
            </span>
          </p>
        }
        confirmLabel="삭제"
        variant="danger"
        busy={busy}
        onConfirm={submitDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}
