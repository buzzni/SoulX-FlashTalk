// Primitive UI components — ported verbatim from prototype primitives.jsx.
// Divergence from prototype: ES module imports; named exports instead of window globals.
import { useState, useEffect, useRef } from 'react';
import Icon from './Icon.jsx';

/* ---------- Button ---------- */
export const Button = ({ children, variant = 'secondary', size = '', icon, iconRight, onClick, disabled, type = 'button', className = '', style, ...rest }) => (
  <button
    type={type}
    className={`btn btn-${variant} ${size ? `btn-${size}` : ''} ${className}`}
    onClick={onClick}
    disabled={disabled}
    style={style}
    {...rest}
  >
    {icon && <Icon name={icon} size={size === 'sm' ? 13 : 14} />}
    {children}
    {iconRight && <Icon name={iconRight} size={size === 'sm' ? 13 : 14} />}
  </button>
);

/* ---------- Segmented ---------- */
export const Segmented = ({ options, value, onChange }) => (
  <div className="seg" role="tablist">
    {options.map(o => (
      <button
        key={o.value}
        role="tab"
        aria-selected={value === o.value}
        className={value === o.value ? 'on' : ''}
        onClick={() => onChange(o.value)}
      >
        {o.icon && <Icon name={o.icon} size={13} />}
        {o.label}
      </button>
    ))}
  </div>
);

/* ---------- Slider ---------- */
export const Slider = ({ value, onChange, min = 0, max = 1, step = 0.01, formatValue, ariaLabel }) => {
  const trackRef = useRef(null);
  const dragging = useRef(false);

  const pct = ((value - min) / (max - min)) * 100;

  const handleMove = (clientX) => {
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const raw = min + ratio * (max - min);
    const snapped = Math.round(raw / step) * step;
    onChange(Number(snapped.toFixed(3)));
  };
  const onDown = (e) => {
    dragging.current = true;
    handleMove(e.clientX);
    e.preventDefault();
  };
  const onKey = (e) => {
    // a11y Tier-1: keyboard stepping
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(Math.max(min, Number((value - step).toFixed(3))));
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(Math.min(max, Number((value + step).toFixed(3))));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onChange(min);
    } else if (e.key === 'End') {
      e.preventDefault();
      onChange(max);
    }
  };
  useEffect(() => {
    const move = (e) => { if (dragging.current) handleMove(e.clientX); };
    const up = () => { dragging.current = false; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  });

  return (
    <div className="slider-row">
      <div
        className="slider-track"
        ref={trackRef}
        onMouseDown={onDown}
        role="slider"
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={0}
        onKeyDown={onKey}
      >
        <div className="slider-fill" style={{ width: `${pct}%` }} />
        <div className="slider-thumb" style={{ left: `${pct}%` }} />
      </div>
      <span className="slider-value num">{formatValue ? formatValue(value) : value}</span>
    </div>
  );
};

/* ---------- Upload tile ---------- */
export const UploadTile = ({ file, onFile, onRemove, label = '클릭 또는 드래그해서 업로드', sub = 'JPG, PNG · 최대 20MB', accept = 'image/*', compact = false }) => {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);
  const handleFile = (f) => {
    if (!f) return;
    console.log('[UploadTile] handleFile', { name: f.name, size: f.size, type: f.type, isFile: f instanceof File, isBlob: f instanceof Blob });
    const reader = new FileReader();
    reader.onload = (e) => {
      const urlLen = typeof e.target.result === 'string' ? e.target.result.length : 0;
      console.log('[UploadTile] FileReader.onload', { name: f.name, urlLen, urlHead: (e.target.result || '').slice(0, 40) });
      onFile({ name: f.name, size: f.size, type: f.type, url: e.target.result, _fake: false, _file: f });
    };
    reader.onerror = (e) => {
      console.error('[UploadTile] FileReader.onerror', {
        readerError: reader.error ? { name: reader.error.name, message: reader.error.message, code: reader.error.code } : null,
        readyState: reader.readyState,
      });
      // No blob URL fallback — creating an <img src="blob:..."> that Chromium
      // can't resolve on network-IP origins ties up a socket in the connection
      // pool per tile and causes subsequent POSTs to queue until timeout.
      // Preview just stays blank; the File is preserved so upload still works.
      onFile({ name: f.name, size: f.size, type: f.type, url: null, _fake: false, _file: f });
    };
    reader.onabort = () => {
      console.warn('[UploadTile] FileReader.onabort', { readyState: reader.readyState });
    };
    try {
      reader.readAsDataURL(f);
    } catch (err) {
      console.error('[UploadTile] readAsDataURL threw synchronously', err);
      onFile({ name: f.name, size: f.size, type: f.type, url: null, _fake: false, _file: f });
    }
  };
  const fakeUpload = () => {
    const fake = {
      name: `reference_${Date.now().toString(36)}.jpg`,
      size: Math.floor(Math.random() * 2e6 + 1e5),
      type: 'image/jpeg',
      url: null,
      _fake: true,
    };
    onFile(fake);
  };

  if (file) {
    return (
      <div className="upload-tile has-file">
        <input type="file" accept={accept} ref={inputRef} style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
        <div className="file-thumb" onClick={() => inputRef.current?.click()} style={{ cursor: 'pointer' }}>
          {file.url ? <img src={file.url} alt={file.name} /> :
            <div className="striped-placeholder">{file.name.toLowerCase().includes('.mp3') || file.name.toLowerCase().includes('.wav') ? 'AUDIO' : 'IMAGE'}<br/>reference</div>}
        </div>
        <div className="file-meta">
          <span className="truncate">{file.name}</span>
          <span className="mono">{(file.size / 1024).toFixed(0)}KB</span>
        </div>
        <div className="file-buttons">
          <button className="file-btn" onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}>
            <Icon name="swap" size={12} /> 교체
          </button>
          <button className="file-btn file-btn-danger" onClick={(e) => { e.stopPropagation(); onRemove?.(); }}>
            <Icon name="trash" size={12} /> 삭제
          </button>
        </div>
      </div>
    );
  }

  // Clipboard paste handler — bypasses FileReader / multipart-POST paths that
  // AhnLab ASTx and similar enterprise security agents tend to block. Image
  // bytes come from Chrome's clipboard buffer rather than an OS file handle,
  // so the NotReadableError trigger (file-lock / snapshot-state) doesn't apply.
  const onPaste = (e) => {
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
      style={dragOver ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } : {}}
      tabIndex={0}
      onClick={() => { inputRef.current?.click(); }}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
      onPaste={onPaste}
    >
      <input type="file" accept={accept} ref={inputRef} style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
      <Icon name="upload" size={compact ? 18 : 22} />
      <div className="label">{label}</div>
      <div className="sub">{sub}</div>
      <div className="sub" style={{ marginTop: 4, fontSize: 10, color: 'var(--text-tertiary)' }}>
        또는 이미지 복사 후 이 영역에 <kbd style={{ fontFamily: 'monospace', padding: '0 4px', border: '1px solid var(--border)', borderRadius: 3 }}>Ctrl+V</kbd> / <kbd style={{ fontFamily: 'monospace', padding: '0 4px', border: '1px solid var(--border)', borderRadius: 3 }}>Cmd+V</kbd>
      </div>
      <button className="btn btn-secondary btn-sm mt-1" onClick={e => { e.stopPropagation(); fakeUpload(); }} type="button">
        샘플 사용
      </button>
    </div>
  );
};

/* ---------- Chip ---------- */
export const Chip = ({ on, onClick, children }) => (
  <button
    className={`chip ${on ? 'on' : ''}`}
    onClick={onClick}
    type="button"
    aria-pressed={!!on}
  >{children}</button>
);

/* ---------- Badge ---------- */
export const Badge = ({ variant = 'neutral', children, icon }) => (
  <span className={`badge badge-${variant}`}>
    {icon && <Icon name={icon} size={11} />}
    {children}
  </span>
);

/* ---------- Card ---------- */
export const Card = ({ title, subtitle, eyebrow, action, children, style }) => (
  <section className="card" style={style}>
    {(title || subtitle || eyebrow || action) && (
      <div className="card-header">
        <div>
          {eyebrow && <div className="card-eyebrow">{eyebrow}</div>}
          {title && <div className="card-title">{title}</div>}
          {subtitle && <div className="card-subtitle">{subtitle}</div>}
        </div>
        {action}
      </div>
    )}
    {children}
  </section>
);

/* ---------- Field ---------- */
export const Field = ({ label, hint, children }) => (
  <div className="field">
    {label && <label>{label}{hint && <span className="hint">{hint}</span>}</label>}
    {children}
  </div>
);

/* ---------- Modal ---------- */
export const Modal = ({ open, onClose, title, children, footer }) => {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="닫기"><Icon name="close" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{footer}</div>}
      </div>
    </div>
  );
};
