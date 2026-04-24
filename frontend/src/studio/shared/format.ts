/**
 * Display formatters shared across render + result views.
 *
 * Two elapsed variants because the two call sites track elapsed in
 * different units: useRenderJob ticks in milliseconds (Date.now()
 * math), /api/results returns `generation_time_sec` already in seconds.
 * Converting at the call site would be lossy, and keeping one helper
 * per source is cheaper than a units-aware polymorphic one.
 */

/** Elapsed time formatter — `m:ss`. Input is milliseconds. */
export function formatElapsedMs(ms: number | null | undefined): string {
  const n = Number.isFinite(ms) ? (ms as number) : 0;
  const total = Math.max(0, Math.floor(n / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Elapsed time formatter — `m:ss`. Input is seconds. Returns `—` for missing. */
export function formatElapsedSec(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** ISO timestamp → `2026-04-23 14:22:30`. `toLocaleString('ko-KR')`
 * is too noisy for the narrow column this lands in. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Human-readable file size. Accepts bytes or null/0 (renders `—`). */
export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}
