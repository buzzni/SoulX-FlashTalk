import { useState, useRef } from 'react';
import { Upload, RefreshCcw, Trash2 } from 'lucide-react';

/**
 * UploadTile — file dropzone with click / drag / paste. Custom because
 * shadcn ships no equivalent. The paste-from-clipboard fallback exists
 * specifically because some enterprise security agents (AhnLab ASTx and
 * friends) block FileReader/multipart-POST paths but allow clipboard reads.
 *
 * Migrated to Tailwind utilities so it isn't tied to .studio-root scope
 * anymore. Tokens stay (--accent, --accent-soft) for the wizard color bridge.
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
      <div className="upload-tile has-file">
        <input
          type="file"
          accept={accept}
          ref={inputRef}
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        <div
          className="file-thumb cursor-pointer"
          onClick={() => inputRef.current?.click()}
        >
          {file.url ? (
            <img src={file.url} alt={file.name ?? ''} />
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
        <div className="file-meta">
          <span className="truncate">{file.name ?? ''}</span>
          <span className="font-mono">{((file.size ?? 0) / 1024).toFixed(0)}KB</span>
        </div>
        <div className="file-buttons">
          <button
            className="file-btn"
            onClick={(e) => {
              e.stopPropagation();
              inputRef.current?.click();
            }}
          >
            <RefreshCcw className="size-3" />
            교체
          </button>
          <button
            className="file-btn file-btn-danger"
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
      className="upload-tile"
      style={dragOver ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } : undefined}
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
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
    >
      <input
        type="file"
        accept={accept}
        ref={inputRef}
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      <Upload className={compact ? 'size-4' : 'size-5'} />
      <div className="label">{label}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}
