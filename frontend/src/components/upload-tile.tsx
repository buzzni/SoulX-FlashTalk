import { useState, useRef } from 'react';
import { Upload, RefreshCcw, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * UploadTile — file dropzone with click / drag / paste.
 *
 * Custom because shadcn ships no equivalent. The paste-from-clipboard
 * fallback exists specifically because some enterprise security agents
 * (AhnLab ASTx and friends) block FileReader/multipart-POST paths but
 * allow clipboard reads.
 *
 * Migrated from `.upload-tile`/`.upload-tile.has-file`/`.file-*` BEM to
 * inline Tailwind utilities (Phase C-8). Empty + has-file states match
 * heights (132px floor) so the surrounding layout doesn't jump on pick.
 */

// Shape consumers pass — narrow types like RefFile / UploadedAudio /
// CloneSample all conform to this loose shape. Kept loose so we don't
// have to refactor every domain type in lock-step with the picker UI.
export interface UploadedFile {
  name?: string;
  size?: number;
  type?: string;
  url?: string | null;
  _fake?: boolean;
  _file?: File;
}

export interface UploadTileProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  file?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onFile: (file: any) => void;
  onRemove?: () => void;
  label?: string;
  sub?: string;
  accept?: string;
  compact?: boolean;
}

// Reused shells so consumers can stamp out a server-asset confirmation
// row (BackgroundPicker) with the same chrome.
export const UPLOAD_TILE_HAS_FILE_CLASS =
  'min-h-[132px] grid grid-cols-[auto_1fr_auto] grid-rows-[auto] items-center gap-3.5 p-3 rounded-lg border border-border bg-card cursor-default';
export const UPLOAD_TILE_THUMB_CLASS =
  'w-[108px] h-[108px] rounded shrink-0 overflow-hidden flex items-center justify-center bg-secondary relative';
export const UPLOAD_TILE_FILE_BTN_CLASS =
  'inline-flex items-center justify-center gap-1.5 px-3 py-[7px] rounded-sm border border-border bg-card text-ink-2 text-xs font-semibold cursor-pointer transition-[background-color,border-color,color] duration-150 hover:bg-secondary hover:text-foreground hover:border-rule-strong';
export const UPLOAD_TILE_FILE_BTN_DANGER_CLASS =
  'hover:bg-destructive-soft hover:text-destructive hover:border-destructive';

export function UploadTile({
  file,
  onFile,
  onRemove,
  label = '클릭 또는 드래그해서 업로드',
  sub = 'JPG, PNG · 최대 20MB',
  accept = 'image/*',
  compact = false,
}: UploadTileProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset value before opening the picker so re-selecting the same
  // file (after delete or replace) still fires `onChange`. Browsers
  // suppress the event when the value is unchanged.
  const openPicker = () => {
    if (!inputRef.current) return;
    inputRef.current.value = '';
    inputRef.current.click();
  };

  const handleFile = (f: File | undefined) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      onFile({
        name: f.name,
        size: f.size,
        type: f.type,
        url: typeof e.target?.result === 'string' ? e.target.result : null,
        _fake: false,
        _file: f,
      });
    };
    reader.onerror = () => {
      // No blob URL fallback — Chromium can't resolve blob:// on network-IP
      // origins. Preview blank, but the File ref still uploads fine.
      onFile({ name: f.name, size: f.size, type: f.type, url: null, _fake: false, _file: f });
    };
    try {
      reader.readAsDataURL(f);
    } catch {
      onFile({ name: f.name, size: f.size, type: f.type, url: null, _fake: false, _file: f });
    }
  };

  if (file) {
    return (
      <div className={UPLOAD_TILE_HAS_FILE_CLASS}>
        <input
          type="file"
          accept={accept}
          ref={inputRef}
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        <div
          className={cn(UPLOAD_TILE_THUMB_CLASS, 'cursor-pointer')}
          onClick={() => openPicker()}
        >
          {file.url ? (
            <img
              src={file.url}
              alt={file.name ?? ''}
              className="w-full h-full object-cover block"
            />
          ) : (
            <div className="striped-placeholder">
              {(file.name ?? '').toLowerCase().endsWith('.mp3') ||
              (file.name ?? '').toLowerCase().endsWith('.wav')
                ? 'AUDIO'
                : 'IMAGE'}
              <br />
              reference
            </div>
          )}
        </div>
        <div className="flex flex-col gap-0.5 min-w-0 text-[13px] text-foreground">
          <span className="truncate font-semibold tracking-tight">{file.name ?? ''}</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {((file.size ?? 0) / 1024).toFixed(0)}KB
          </span>
        </div>
        <div className="flex gap-1 shrink-0">
          <button
            className={UPLOAD_TILE_FILE_BTN_CLASS}
            onClick={(e) => {
              e.stopPropagation();
              openPicker();
            }}
          >
            <RefreshCcw className="size-3" />
            교체
          </button>
          <button
            className={cn(UPLOAD_TILE_FILE_BTN_CLASS, UPLOAD_TILE_FILE_BTN_DANGER_CLASS)}
            onClick={(e) => {
              e.stopPropagation();
              onRemove?.();
            }}
          >
            <Trash2 className="size-3" />
            삭제
          </button>
        </div>
      </div>
    );
  }

  // Clipboard paste handler — bypasses FileReader/multipart-POST paths that
  // some enterprise security agents block.
  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        e.preventDefault();
        const f = it.getAsFile();
        if (f) handleFile(f);
        return;
      }
    }
  };

  return (
    <div
      tabIndex={0}
      onClick={() => openPicker()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFile(e.dataTransfer.files[0]);
      }}
      onPaste={onPaste}
      className={cn(
        'min-h-[132px] flex flex-col items-center justify-center gap-2 px-5 py-7 rounded-lg border-[1.5px] border-dashed border-rule-strong bg-card text-ink-2 text-center cursor-pointer transition-[border-color,background-color,color,transform] duration-150',
        'hover:border-primary hover:bg-primary-soft hover:text-primary-on-soft hover:-translate-y-px',
      )}
      style={
        dragOver
          ? { borderColor: 'var(--primary)', background: 'var(--accent-soft)' }
          : undefined
      }
    >
      <input
        type="file"
        accept={accept}
        ref={inputRef}
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      <Upload className={compact ? 'size-4' : 'size-5'} />
      <div className="text-sm font-semibold tracking-tight text-inherit">{label}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}
