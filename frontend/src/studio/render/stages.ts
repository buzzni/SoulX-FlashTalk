/**
 * Stage mapping + elapsed/timestamp formatters for the render view.
 *
 * Backend emits more granular stage keys than we render. We group
 * into 5 user-visible buckets so the checklist advances cleanly.
 * Anything we don't recognize (older worker builds, future
 * additions) falls back to a progress-% heuristic.
 *
 * Pure functions — no React imports, lives outside the component
 * folder so tests can assert mappings directly.
 */

export interface StageEntry {
  key: string;
  label: string;
  backendKeys: string[];
}

export const STAGES: StageEntry[] = [
  { key: 'queued', label: '대기열 등록 중', backendKeys: ['queued'] },
  { key: 'composite', label: '제품·배경 합치는 중', backendKeys: ['compositing_bg'] },
  { key: 'voice', label: '목소리와 입 모양 맞추는 중', backendKeys: ['loading', 'preparing'] },
  { key: 'render', label: '쇼호스트 움직임 만드는 중', backendKeys: ['generating'] },
  { key: 'encode', label: '영상 파일로 만드는 중', backendKeys: ['saving', 'compositing'] },
];

export function resolveStageIdx(
  backendStage: string | null | undefined,
  progressPct: number | null | undefined,
): number {
  if (backendStage) {
    const idx = STAGES.findIndex((s) => s.backendKeys.includes(backendStage));
    if (idx >= 0) return idx;
  }
  const p = Number.isFinite(progressPct) ? (progressPct as number) : 0;
  if (p >= 90) return 4;
  if (p >= 28) return 3;
  if (p >= 10) return 2;
  if (p >= 2) return 1;
  return 0;
}

/** Elapsed time formatter — `m:ss`. Input is milliseconds. */
export function formatElapsed(ms: number | null | undefined): string {
  const n = Number.isFinite(ms) ? (ms as number) : 0;
  const total = Math.max(0, Math.floor(n / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** ISO timestamp → `2026-04-23 14:22:30` (readable inline in a
 * narrow card column; `toLocaleString('ko-KR')` is too noisy). */
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

/** Human-readable file size. Accepts bytes or null/0 (renders "—"). */
export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}
