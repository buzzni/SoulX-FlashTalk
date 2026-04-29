/**
 * Display formatters — convert raw backend values into human-friendly
 * strings for UI surfaces. Centralized so we get consistent formatting
 * across home recent works, results grid, mypage stats, history page.
 */

/**
 * Canonical title for a video record. Delegates to `formatTaskTitle` so
 * the library page reads identically to the queue popover, RenderDashboard,
 * and ResultPage — "내 쇼호스트 영상 #ABCD" / "내 멀티 대화 #ABCD".
 *
 * Phase 2 (deferred per docs/results-page-overhaul-plan.md decision #15):
 * once `display_name` ships, prefer it over the canonical fallback:
 *
 *     return item.display_name?.trim() || formatTaskTitle(item.task_id, item.type);
 *
 * Old script_text/filename derivation removed (Codex T2): the prompt
 * preview was usually mid-sentence cut and read poorly.
 */
import { formatTaskTitle } from '../studio/taskFormat';

export function videoTitle(item: {
  task_id?: string | null;
  type?: 'generate' | 'conversation' | null;
}): string {
  return formatTaskTitle(item.task_id || '', item.type || 'generate');
}

/**
 * Resolve a backend reference (storage_key, legacy absolute path, or
 * pre-formed URL) to a URL the browser can load.
 *
 * Post PR S3+ + production-cutover PR-1: backend `/api/results` enriches
 * media references with `*url` siblings populated via
 * `media_store.url_for`, so direct callers who already receive a `url`
 * field should use it instead of mangling paths. This helper exists for
 * surfaces that still consume raw `path` / `storage_key` fields and
 * need a frontend-routable URL on the spot.
 *
 * Inputs handled:
 *   - Absolute http(s) URLs (presigned S3 etc): passed through.
 *   - Pre-formed `/api/...` URLs: prefixed with `${API_BASE}` so they
 *     resolve correctly when frontend runs on a different origin from
 *     backend (separated deploy).
 *   - Storage keys (`outputs/...`, `uploads/...`, `examples/...`):
 *     wrapped as `${API_BASE}/api/files/<key>`.
 *   - Legacy absolute filesystem paths (`/opt/.../outputs/x.png`):
 *     stripped to the first bucket segment, then wrapped as above.
 *
 * Returns `null` for unresolvable inputs (off-roots, empty, non-string).
 */
import { API_BASE } from '../api/http';

const BUCKETS = ['outputs', 'uploads', 'examples'] as const;

export function outputsPathToUrl(input: string | null | undefined): string | null {
  if (!input || typeof input !== 'string') return null;
  if (/^https?:\/\//.test(input)) return input;
  if (input.startsWith('/api/')) return `${API_BASE}${input}`;

  // Storage-key form: bucket-prefixed, no leading slash
  const head = input.split('/', 1)[0] ?? '';
  if ((BUCKETS as readonly string[]).includes(head)) {
    return `${API_BASE}/api/files/${input}`;
  }

  // Legacy absolute path: locate the first bucket segment, slice from there.
  const parts = input.replace(/\\/g, '/').split('/');
  for (const bucket of BUCKETS) {
    const idx = parts.indexOf(bucket);
    if (idx >= 0) {
      return `${API_BASE}/api/files/${parts.slice(idx).join('/')}`;
    }
  }
  return null;
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
 *   2026-04-26T05:32:11 → "2026.04.26 05:32"
 */
export function formatCompactDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mn = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}.${mm}.${dd} ${hh}:${mn}`;
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
