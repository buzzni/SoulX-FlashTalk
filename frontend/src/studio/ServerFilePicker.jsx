// Picker for files already on the server's uploads/ dir. DLP/VPN environments
// often block browser uploads but allow scp/rsync over SSH — so the workflow is:
// user runs `scp foo.png <server>:<project>/uploads/` once, then opens this
// picker and selects from the list. No browser file-read needed.
import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { listServerFiles } from './api.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RefreshCcw } from 'lucide-react';

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

  const ONE_HOUR = 60 * 60;
  const nowSec = Date.now() / 1000;
  const filtered = (files || []).filter((f) => {
    if (recentOnly && nowSec - f.modified > ONE_HOUR) return false;
    if (query && !f.filename.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  const formatSize = (b) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  };
  const formatTime = (t) =>
    new Date(t * 1000).toLocaleString('ko-KR', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose?.(); }}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-hidden flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 py-4 border-b border-border gap-1">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle className="text-base">서버에 있는 파일에서 선택</DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={refresh}
              title="새로고침"
              aria-label="새로고침"
            >
              <RefreshCcw className="size-3.5" />
            </Button>
          </div>
          <DialogDescription className="text-[12px]">
            업로드가 막히는 환경에서는{' '}
            <code className="font-mono bg-muted px-1.5 py-0.5 rounded text-[11px]">
              scp foo.png 서버:프로젝트/uploads/
            </code>{' '}
            로 올린 뒤 여기서 고르세요.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2.5 px-5 py-3 border-b border-border bg-muted/40">
          <Input
            type="text"
            placeholder="파일명 검색…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            className="flex-1 min-w-[200px] h-8"
          />
          <label className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={recentOnly}
              onChange={(e) => setRecentOnly(e.target.checked)}
              className="accent-primary"
            />
            최근 1시간만
          </label>
          <span className="text-[11px] text-muted-foreground">
            {files ? `${filtered.length} / ${files.length} 개` : ''}
          </span>
        </div>

        <div className="overflow-auto flex-1 min-h-0 p-5">
          {loading && (
            <div className="py-10 text-center text-muted-foreground text-[13px]">
              불러오는 중…
            </div>
          )}

          {error && (
            <div className="px-3 py-2 rounded-md border bg-[hsl(0_90%_96%)] text-destructive border-destructive/30 text-[13px] flex items-center gap-2">
              <Icon name="alert_circle" size={13} />
              {error}
            </div>
          )}

          {!loading && !error && files && files.length === 0 && (
            <div className="py-10 text-center text-muted-foreground text-[13px]">
              서버에 해당 유형의 파일이 없어요. 먼저{' '}
              <code className="font-mono bg-muted px-1.5 rounded">scp</code> 로
              업로드해주세요.
            </div>
          )}

          {!loading && !error && files && files.length > 0 && filtered.length === 0 && (
            <div className="py-10 text-center text-muted-foreground text-[13px]">
              검색 결과가 없어요. 검색어를 지우거나 "최근 1시간만" 체크를 해제해보세요.
            </div>
          )}

          {!loading && !error && filtered.length > 0 && (
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(140px,1fr))]">
              {filtered.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => {
                    onSelect(f);
                    onClose();
                  }}
                  className="flex flex-col text-left rounded-md overflow-hidden border border-border bg-card cursor-pointer transition-all hover:border-primary hover:shadow-[0_0_0_2px_hsl(218_100%_50%/0.15)]"
                >
                  <div className="aspect-square bg-foreground overflow-hidden relative">
                    {kind === 'image' ? (
                      <img
                        src={f.url}
                        alt={f.filename}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="absolute inset-0 grid place-items-center text-muted-foreground">
                        <Icon name="sound" size={28} />
                      </div>
                    )}
                  </div>
                  <div className="px-2.5 py-2 text-[11px]">
                    <div className="truncate font-medium">{f.filename}</div>
                    <div className="font-mono text-[10px] text-muted-foreground mt-0.5 flex justify-between">
                      <span>{formatSize(f.size)}</span>
                      <span>{formatTime(f.modified)}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
