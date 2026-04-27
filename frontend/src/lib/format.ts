/**
 * Display formatters — convert raw backend values into human-friendly
 * strings for UI surfaces. Centralized so we get consistent formatting
 * across home recent works, results grid, mypage stats, history page.
 */

/**
 * Extract a human title from a raw video record.
 *
 * Backend may give us:
 *  - `script_text` (clean prompt text — best signal)
 *  - `host_image` (filesystem path like /opt/home/jack/.../woman.png)
 *  - `output_path` (filesystem path)
 *  - `task_id` (UUID — last resort)
 *
 * Strategy: prefer script (truncated), then strip path → basename → strip
 * extension/timestamps, finally short task ID with prefix.
 */
export function videoTitle(item: {
  script_text?: string | null;
  host_image?: string | null;
  output_path?: string | null;
  task_id?: string | null;
}): string {
  const script = (item.script_text || '').trim();
  if (script) {
    // Single-line, ~60 char preview
    const oneLine = script.replace(/\s+/g, ' ');
    return oneLine.length > 64 ? `${oneLine.slice(0, 60)}…` : oneLine;
  }

  for (const raw of [item.host_image, item.output_path]) {
    if (!raw) continue;
    const base = basename(raw);
    if (!base) continue;
    const cleaned = base
      .replace(/\.[a-z0-9]+$/i, '') // ext
      .replace(/^\d{4}-\d{2}-\d{2}[T_-]?\d{0,6}[_-]?/, '') // leading timestamp
      .replace(/_/g, ' ')
      .trim();
    if (cleaned) return cleaned;
  }

  const id = item.task_id || '';
  return id ? `영상 #${id.slice(0, 6).toUpperCase()}` : '영상';
}

function basename(p: string): string {
  // Handle both POSIX and Windows separators just in case.
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Format a generation_time (seconds, fractional) into a human string.
 *   0.4   → "0.4초"
 *   12.7  → "13초"
 *   95    → "1분 35초"
 *   3299  → "55분"   ← guard against the data bug we saw in dev
 */
export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 1) return `${sec.toFixed(1)}초`;
  if (sec < 60) return `${Math.round(sec)}초`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s ? `${m}분 ${s}초` : `${m}분`;
  const h = Math.floor(m / 60);
  return `${h}시간 ${m % 60}분`;
}

/**
 * Format bytes into human size.  1234 → "1.2KB"
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)}KB`;
  const mb = kb / 1024;
  return mb < 100 ? `${mb.toFixed(1)}MB` : `${Math.round(mb)}MB`;
}

/**
 * Format an ISO date for compact display (used in card meta rows).
 *   2026-04-26T05:32:11 → "04.26 · 05:32"
 */
export function formatCompactDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mn = String(d.getMinutes()).padStart(2, '0');
  return `${mm}.${dd} · ${hh}:${mn}`;
}

const DAY_MS = 86_400_000;

function diffDaysFromToday(d: Date): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - target.getTime()) / DAY_MS);
}

/**
 * Korean relative date+time ("오늘 14:32", "어제 14:32", "3일 전",
 * "M월 D일"). Recent items show clock minutes; older items collapse to
 * the date.
 */
export function formatRelativeDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffDays = diffDaysFromToday(d);
  const hh = String(d.getHours()).padStart(2, '0');
  const mn = String(d.getMinutes()).padStart(2, '0');
  if (diffDays === 0) return `오늘 ${hh}:${mn}`;
  if (diffDays === 1) return `어제 ${hh}:${mn}`;
  if (diffDays < 7) return `${diffDays}일 전`;
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/**
 * Korean relative date ("오늘", "어제", "3일 전", "MM월 DD일").
 */
export function formatRelativeDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffDays = diffDaysFromToday(d);
  if (diffDays === 0) return '오늘';
  if (diffDays === 1) return '어제';
  if (diffDays < 7) return `${diffDays}일 전`;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}월 ${dd}일`;
}
