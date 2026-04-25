/**
 * PlaylistPicker — Step 3 footer playlist assignment.
 *
 * Uses shadcn Select (Radix) instead of a native <select> so the dropdown
 * chrome matches the rest of the wizard (Pretendard, primary blue, custom
 * focus ring) and gets keyboard nav + portal rendering for free.
 *
 * Inline-create lives below the trigger and auto-selects the new playlist
 * (plan §6). Graceful degrade per plan decision #13: if /api/playlists
 * fails to load, render the warning + retry. The user can still ship the
 * render — it lands in 미지정.
 */

import { useEffect, useState } from 'react';
import { listPlaylists, createPlaylist, type Playlist } from '../../api/playlists';
import { humanizeError } from '../../api/http';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertCircle, Plus } from 'lucide-react';

export interface PlaylistPickerProps {
  selected: string | null; // playlist_id or null = 미지정
  onChange: (playlistId: string | null) => void;
}

const UNASSIGNED = '__unassigned__';
const CREATE = '__create__';

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
      <div className="flex items-center gap-2 px-3 py-2 text-xs rounded-md border border-[hsl(38_92%_50%/0.4)] bg-[hsl(38_92%_96%)] text-[hsl(38_92%_30%)]">
        <AlertCircle className="size-3.5 shrink-0" />
        <span className="flex-1">
          플레이리스트 목록을 못 불러왔어요 · 이번 영상은 미지정으로 저장됩니다
        </span>
        <Button size="sm" variant="ghost" onClick={() => loadList()}>
          다시 시도
        </Button>
      </div>
    );
  }

  const handleValueChange = (v: string) => {
    if (v === CREATE) {
      setShowCreate(true);
      return;
    }
    if (v === UNASSIGNED) {
      onChange(null);
      return;
    }
    onChange(v);
  };

  const triggerValue = selected ?? UNASSIGNED;

  return (
    <div className="flex flex-col gap-2">
      <Select
        value={triggerValue}
        onValueChange={handleValueChange}
        disabled={playlists === null}
      >
        <SelectTrigger className="w-full max-w-xs">
          <SelectValue placeholder="미지정" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value={UNASSIGNED}>미지정</SelectItem>
            {playlists?.map((p) => (
              <SelectItem key={p.playlist_id} value={p.playlist_id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectItem
            value={CREATE}
            className="text-primary focus:text-primary"
          >
            <Plus className="size-3.5" />
            새 플레이리스트 만들기
          </SelectItem>
        </SelectContent>
      </Select>
      {showCreate && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="플레이리스트 이름 (예: 겨울 컬렉션)"
            autoFocus
            className="flex-1 min-w-[200px]"
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
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
          >
            {creating ? '...' : '만들기'}
          </Button>
          <Button size="sm" variant="ghost" onClick={closeCreate} disabled={creating}>
            취소
          </Button>
          {createError && (
            <div className="w-full text-xs text-destructive">{createError}</div>
          )}
        </div>
      )}
    </div>
  );
}
