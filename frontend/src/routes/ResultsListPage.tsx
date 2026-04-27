/**
 * /results — 완성된 영상 + 플레이리스트.
 *
 * Korean Productivity 결: 페이지 헤딩 + 플레이리스트 chip 가로 스트립 +
 * 영상 그리드. 메인 사이드바는 AppLayout, 플레이리스트 필터는 chip
 * 가로 strip (이전엔 별도 사이드바였음 — 마스터 사이드바와 공간 충돌).
 */
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { MoreHorizontal, Plus, Play } from 'lucide-react';
import { AppLayout } from './AppLayout';
import { Spinner } from '../components/spinner';
import { EmptyState } from '../components/empty-state';
import { videoTitle, formatCompactDate, formatDuration } from '../lib/format';
import { startNewVideo } from '../lib/wizardNav';
import { cn } from '@/lib/utils';
import { fetchJSON, humanizeError } from '../api/http';
import { schemas } from '../api/schemas-generated';
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

type Filter = 'all' | 'unassigned' | string;

export function ResultsListPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistListResponse | null>(null);
  const [playlistsError, setPlaylistsError] = useState<string | null>(null);

  const [epoch, setEpoch] = useState(0);
  const refresh = useCallback(() => setEpoch((n) => n + 1), []);

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

  useEffect(() => {
    const ctl = new AbortController();
    setItems(null);
    setHistoryError(null);
    const qs =
      filter === 'all' ? '' : `&playlist_id=${encodeURIComponent(filter)}`;
    fetchJSON(`/api/history?limit=200${qs}`, {
      signal: ctl.signal,
      label: '내 영상 목록',
      schema: schemas.HistoryResponse,
    })
      .then((r) => setItems((r.videos ?? []) as HistoryItem[]))
      .catch((e) => {
        if ((e as { name?: string })?.name === 'AbortError') return;
        setHistoryError(humanizeError(e));
      });
    return () => ctl.abort();
  }, [filter, epoch]);

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

  const totalCount =
    (playlists?.unassigned_count ?? 0) +
    (playlists?.playlists ?? []).reduce((s, p) => s + p.video_count, 0);

  return (
    <AppLayout active="results">
      <div className="px-6 md:px-12 pt-12 md:pt-16 pb-16 max-w-[1280px] animate-rise">
        {/* Page heading */}
        <div className="mb-6">
          <div className="text-sm-tight text-muted-foreground mb-1.5">라이브러리</div>
          <h1 className="headline-section m-0">{filterTitle}</h1>
          {items !== null && (
            <p className="m-0 mt-1 text-sm-tight text-muted-foreground">
              {items.length}개의 영상
            </p>
          )}
        </div>

        {/* Playlist filter strip */}
        <PlaylistChips
          playlists={playlists}
          totalCount={totalCount}
          selected={filter}
          onSelect={setFilter}
          onChanged={refresh}
          onCreated={(p) => {
            refresh();
            setFilter(p.playlist_id);
          }}
          error={playlistsError}
        />

        {historyError && (
          <div className="mt-4 px-4 py-3 text-sm-tight bg-destructive-soft text-destructive border border-destructive/30 rounded-md">
            {historyError}
          </div>
        )}

        {!historyError && items === null && (
          <div className="mt-8 flex items-center gap-2 text-sm-tight text-muted-foreground">
            <Spinner size="sm" /> 불러오는 중
          </div>
        )}

        {!historyError && items !== null && items.length === 0 && (
          <div className="mt-6 surface-card animate-fade-in">
            <EmptyState
              kind={filter === 'all' ? 'no-videos' : 'no-playlist-items'}
              title={
                filter === 'all'
                  ? '아직 만든 영상이 없어요'
                  : '이 플레이리스트는 비어있어요'
              }
              description={
                filter === 'all'
                  ? '첫 영상을 만들어 라이브러리를 채워보세요.'
                  : '결과 카드의 ⋯ 메뉴에서 이 플레이리스트로 옮겨보세요.'
              }
              action={
                filter === 'all' ? (
                  <button
                    type="button"
                    onClick={() => startNewVideo(navigate)}
                    className="text-primary text-sm-tight font-semibold hover:underline cursor-pointer"
                  >
                    첫 영상 만들러 가기 →
                  </button>
                ) : undefined
              }
            />
          </div>
        )}

        {!historyError && items !== null && items.length > 0 && (
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
        )}
      </div>
    </AppLayout>
  );
}

// ── Playlist chips strip ─────────────────────────────────────────────

interface PlaylistChipsProps {
  playlists: PlaylistListResponse | null;
  totalCount: number;
  selected: Filter;
  onSelect: (f: Filter) => void;
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

// ── Card ─────────────────────────────────────────────────────────────

interface ResultCardProps {
  item: HistoryItem;
  playlists: Playlist[];
  onMoved: () => void;
}

function ResultCard({ item, playlists, onMoved }: ResultCardProps) {
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

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

  // Hover preview — play muted video on hover, pause on leave.
  const onMouseEnter = () => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = 0;
    v.play().catch(() => {});
  };
  const onMouseLeave = () => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
  };

  const videoUrl = item.video_url || `/api/videos/${item.task_id}`;
  const title = videoTitle(item);
  const ts = formatCompactDate(item.timestamp);
  const dur = formatDuration(item.generation_time);

  return (
    <div className="relative group">
      <Link
        to={`/result/${item.task_id}`}
        className="surface-card overflow-hidden no-underline text-foreground transition-all hover:translate-y-[-1px] hover:shadow-[var(--shadow-1)] hover:border-rule-strong block"
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        <div className="relative w-full aspect-video bg-foreground overflow-hidden">
          <video
            ref={videoRef}
            src={videoUrl}
            preload="metadata"
            muted
            playsInline
            loop
            className="block w-full h-full object-cover"
          />
          <span className="absolute top-2 left-2 pill-success">완료</span>
          <span className="absolute inset-0 grid place-items-center pointer-events-none opacity-0 group-hover:opacity-0 [&_.idle]:opacity-100 group-hover:[&_.idle]:opacity-0">
            <span className="idle grid place-items-center size-10 rounded-full bg-background/85 text-foreground transition-opacity">
              <Play className="size-4" fill="currentColor" />
            </span>
          </span>
        </div>
        <div className="p-3.5">
          <div className="font-semibold text-sm tracking-tight line-clamp-1 mb-1" title={title}>
            {title}
          </div>
          <div className="text-2xs text-muted-foreground tabular-nums">
            {ts}{ts && dur !== '—' && ' · '}{dur !== '—' ? dur : ''}
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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
