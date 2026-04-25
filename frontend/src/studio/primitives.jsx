/**
 * Wizard primitives — shadcn/Radix-backed wrappers that preserve the
 * pre-shadcn API surface so existing call sites keep working.
 *
 * Visual primitives (Card, Button, Badge, Dialog, Slider) are real shadcn
 * components underneath, which gives us focus trap / scroll lock / keyboard
 * nav / portal rendering for free. The wrapper layer maps our old prop
 * names (variant="primary"/"danger", icon="sparkles") to shadcn's prop
 * names (variant="default"/"destructive", child <Icon>), so consumers
 * don't have to change.
 *
 * Custom primitives kept here:
 *   - Field (label + hint + child) — shadcn doesn't ship a paired version
 *   - Chip (toggle pill button) — wrapped via shadcn Toggle styling
 *   - Segmented (3-way single-select) — wrapped via shadcn ToggleGroup
 *   - UploadTile (file dropzone with paste support) — app-specific behavior
 *
 * Phase D will inline the shadcn imports at call sites and remove this
 * wrapper file. Until then this is the bridge.
 */
import { useState, useEffect, useRef } from 'react';
import Icon from './Icon.jsx';
import { cn } from '@/lib/utils';
import { Button as ShadButton } from '@/components/ui/button';
import { Badge as ShadBadge } from '@/components/ui/badge';
import {
  Card as ShadCard,
  CardHeader as ShadCardHeader,
  CardTitle as ShadCardTitle,
  CardDescription as ShadCardDescription,
  CardContent as ShadCardContent,
  CardAction as ShadCardAction,
} from '@/components/ui/card';
import {
  Dialog as ShadDialog,
  DialogContent as ShadDialogContent,
  DialogHeader as ShadDialogHeader,
  DialogTitle as ShadDialogTitle,
  DialogFooter as ShadDialogFooter,
} from '@/components/ui/dialog';
import { Slider as ShadSlider } from '@/components/ui/slider';
import { ToggleGroup as ShadToggleGroup, ToggleGroupItem as ShadToggleGroupItem } from '@/components/ui/toggle-group';

/* ---------- Button ---------- */
// Old API: variant in {primary, secondary, ghost, danger}, size in {sm, lg, ''}, icon, iconRight.
// shadcn: variant in {default, secondary, ghost, destructive, outline, link}, size in {default, sm, lg, icon, xs}.
const VARIANT_MAP = {
  primary: 'default',
  secondary: 'outline',
  ghost: 'ghost',
  danger: 'destructive',
};
const SIZE_MAP = {
  sm: 'sm',
  lg: 'lg',
  '': 'default',
};

export const Button = ({
  children,
  variant = 'secondary',
  size = '',
  icon,
  iconRight,
  onClick,
  disabled,
  type = 'button',
  className = '',
  style,
  ...rest
}) => (
  <ShadButton
    type={type}
    variant={VARIANT_MAP[variant] ?? 'outline'}
    size={SIZE_MAP[size] ?? 'default'}
    onClick={onClick}
    disabled={disabled}
    style={style}
    className={className}
    {...rest}
  >
    {icon && <Icon name={icon} size={size === 'sm' ? 13 : 14} />}
    {children}
    {iconRight && <Icon name={iconRight} size={size === 'sm' ? 13 : 14} />}
  </ShadButton>
);

/* ---------- Segmented ---------- */
// Single-select toggle group. shadcn ToggleGroup type="single".
export const Segmented = ({ options, value, onChange }) => (
  <ShadToggleGroup
    type="single"
    value={String(value)}
    onValueChange={(v) => {
      if (!v) return; // ToggleGroup allows empty; protect existing single-select contract
      // Coerce back to original value type (number vs string) by matching options
      const match = options.find((o) => String(o.value) === v);
      if (match) onChange(match.value);
    }}
    variant="outline"
    size="sm"
    className="bg-muted/50 p-0.5 rounded-md"
  >
    {options.map((o) => (
      <ShadToggleGroupItem
        key={String(o.value)}
        value={String(o.value)}
        className="data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm text-muted-foreground border-0 h-7 px-3 text-[13px]"
      >
        {o.icon && <Icon name={o.icon} size={13} />}
        {o.label}
      </ShadToggleGroupItem>
    ))}
  </ShadToggleGroup>
);

/* ---------- Slider ---------- */
// shadcn Slider is array-based (supports range). Wrap to single-number API.
export const Slider = ({ value, onChange, min = 0, max = 1, step = 0.01, formatValue, ariaLabel }) => (
  <div className="flex items-center gap-3">
    <ShadSlider
      value={[value]}
      onValueChange={(v) => onChange(Number(Number(v[0]).toFixed(3)))}
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
      className="flex-1"
    />
    <span className="num text-[12px] text-muted-foreground min-w-[40px] text-right">
      {formatValue ? formatValue(value) : value}
    </span>
  </div>
);

/* ---------- Upload tile ---------- */
// Kept custom — app-specific behavior (FileReader, paste handler, sample button).
// Migrated visual chrome from .upload-tile CSS class to Tailwind so it isn't
// dependent on .studio-root scoping forever.
export const UploadTile = ({ file, onFile, onRemove, label = '클릭 또는 드래그해서 업로드', sub = 'JPG, PNG · 최대 20MB', accept = 'image/*', compact = false }) => {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);
  const handleFile = (f) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      onFile({ name: f.name, size: f.size, type: f.type, url: e.target.result, _fake: false, _file: f });
    };
    reader.onerror = () => {
      // No blob URL fallback — Chromium can't resolve blob:// on network-IP origins
      // and ties up sockets. Preview goes blank; the File ref still uploads fine.
      onFile({ name: f.name, size: f.size, type: f.type, url: null, _fake: false, _file: f });
    };
    try {
      reader.readAsDataURL(f);
    } catch {
      onFile({ name: f.name, size: f.size, type: f.type, url: null, _fake: false, _file: f });
    }
  };
  const fakeUpload = () => {
    onFile({
      name: `reference_${Date.now().toString(36)}.jpg`,
      size: Math.floor(Math.random() * 2e6 + 1e5),
      type: 'image/jpeg',
      url: null,
      _fake: true,
    });
  };

  if (file) {
    return (
      <div className="upload-tile has-file">
        <input type="file" accept={accept} ref={inputRef} style={{ display: 'none' }} onChange={(e) => handleFile(e.target.files[0])} />
        <div className="file-thumb" onClick={() => inputRef.current?.click()} style={{ cursor: 'pointer' }}>
          {file.url ? <img src={file.url} alt={file.name} /> :
            <div className="striped-placeholder">{file.name.toLowerCase().includes('.mp3') || file.name.toLowerCase().includes('.wav') ? 'AUDIO' : 'IMAGE'}<br />reference</div>}
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
  // some enterprise security agents block. Image bytes come from Chrome's
  // clipboard buffer instead of an OS file handle.
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
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
      onPaste={onPaste}
    >
      <input type="file" accept={accept} ref={inputRef} style={{ display: 'none' }} onChange={(e) => handleFile(e.target.files[0])} />
      <Icon name="upload" size={compact ? 18 : 22} />
      <div className="label">{label}</div>
      <div className="sub">{sub}</div>
      <div className="sub" style={{ marginTop: 4, fontSize: 10, color: 'var(--text-tertiary)' }}>
        또는 이미지 복사 후 이 영역에 <kbd className="font-mono px-1 border border-border rounded text-[10px]">Ctrl+V</kbd> / <kbd className="font-mono px-1 border border-border rounded text-[10px]">Cmd+V</kbd>
      </div>
      <ShadButton variant="outline" size="sm" className="mt-1" onClick={(e) => { e.stopPropagation(); fakeUpload(); }} type="button">
        샘플 사용
      </ShadButton>
    </div>
  );
};

/* ---------- Chip ---------- */
// Pill toggle button. Kept hand-rolled (shadcn Toggle is rectangular).
// Uses tokens directly so it inherits the wizard color bridge.
export const Chip = ({ on, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={!!on}
    className={cn(
      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] cursor-pointer transition-colors',
      'border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
      on
        ? 'bg-primary text-primary-foreground border-primary'
        : 'bg-card text-muted-foreground border-border hover:border-input hover:text-foreground',
    )}
  >
    {children}
  </button>
);

/* ---------- Badge ---------- */
// Old variants: neutral, accent, success, warn. Map to shadcn equivalents
// + custom Tailwind classes for semantic colors that shadcn doesn't ship.
const BADGE_VARIANT_MAP = {
  neutral: 'secondary',
  accent: 'default',
  success: 'outline', // override className for green
  warn: 'outline', // override className for amber
};
const BADGE_VARIANT_OVERRIDES = {
  success: 'border-[hsl(142_71%_45%/0.4)] bg-[hsl(142_71%_96%)] text-[hsl(142_71%_30%)]',
  warn: 'border-[hsl(38_92%_50%/0.4)] bg-[hsl(38_92%_96%)] text-[hsl(38_92%_35%)]',
};
export const Badge = ({ variant = 'neutral', children, icon, className }) => (
  <ShadBadge
    variant={BADGE_VARIANT_MAP[variant] ?? 'secondary'}
    className={cn(BADGE_VARIANT_OVERRIDES[variant], 'gap-1', className)}
  >
    {icon && <Icon name={icon} size={11} />}
    {children}
  </ShadBadge>
);

/* ---------- Card ---------- */
// Old API: <Card title subtitle eyebrow action>children</Card>
// Wraps shadcn Card — but the wizard's expectation is "padded box with
// vertical rhythm" not "header / content / footer slots." So we adapt:
// shadcn Card's outer wrapper provides border + radius + shadow; we add
// uniform padding + gap inside via Tailwind.
export const Card = ({ title, subtitle, eyebrow, action, children, style, className = '' }) => (
  <ShadCard
    style={style}
    className={cn(
      'gap-3.5 py-5 px-5 shadow-xs', // override shadcn's default 6 padding
      className,
    )}
  >
    {(title || subtitle || eyebrow || action) && (
      <ShadCardHeader className="px-0 gap-1">
        <div>
          {eyebrow && <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground">{eyebrow}</div>}
          {title && <ShadCardTitle className="text-[15px] tracking-tight">{title}</ShadCardTitle>}
          {subtitle && <ShadCardDescription className="text-[12px]">{subtitle}</ShadCardDescription>}
        </div>
        {action && <ShadCardAction>{action}</ShadCardAction>}
      </ShadCardHeader>
    )}
    <ShadCardContent className="px-0 flex flex-col gap-3.5">
      {children}
    </ShadCardContent>
  </ShadCard>
);

/* ---------- Field ---------- */
// label + hint + child stack. Kept custom (shadcn doesn't ship a paired
// label-hint primitive at this density).
export const Field = ({ label, hint, children }) => (
  <div className="flex flex-col gap-1.5">
    {label && (
      <label className="flex items-center justify-between text-[12px] font-medium text-foreground/80">
        {label}
        {hint && <span className="text-muted-foreground font-normal">{hint}</span>}
      </label>
    )}
    {children}
  </div>
);

/* ---------- Modal ---------- */
// Old: <Modal open onClose title footer>children</Modal>
// shadcn Dialog uses open/onOpenChange — wrap to keep onClose semantics.
export const Modal = ({ open, onClose, title, children, footer }) => (
  <ShadDialog open={open} onOpenChange={(o) => { if (!o) onClose?.(); }}>
    <ShadDialogContent className="sm:max-w-lg">
      {title && (
        <ShadDialogHeader>
          <ShadDialogTitle>{title}</ShadDialogTitle>
        </ShadDialogHeader>
      )}
      <div className="text-[13px] text-foreground leading-relaxed">{children}</div>
      {footer && <ShadDialogFooter>{footer}</ShadDialogFooter>}
    </ShadDialogContent>
  </ShadDialog>
);
