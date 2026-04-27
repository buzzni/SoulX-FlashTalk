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
  // `starting_subprocess` is the first stage emitted by the new
  // FLASHTALK_USE_TORCHRUN_SUBPROCESS path (app.py _run_torchrun_inference)
  // — same UX bucket as queue-pickup. Without it the bar would freeze on
  // the queued copy while torchrun spawns its 2 child workers.
  { key: 'queued', label: '대기열 등록 중', backendKeys: ['queued', 'starting_subprocess'] },
  { key: 'composite', label: '제품·배경 합치는 중', backendKeys: ['compositing_bg'] },
  // `loading_model` (worker pulls 14B weights to GPU) and `compiling`
  // (torch.compile warmup, 1-3 min on first run) both belong here in the
  // user's mental model — model is loaded so it can speak in sync.
  {
    key: 'voice',
    label: '목소리와 입 모양 맞추는 중',
    backendKeys: ['loading', 'preparing', 'loading_model', 'compiling'],
  },
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

// Format helpers moved to studio/shared/format.ts so ResultPage can share
// the same code. Re-exported here under the previous names so existing
// render/* imports keep working. `formatElapsed` (ms-input) is now
// `formatElapsedMs`; the alias preserves callers.
export { formatDateTime, formatFileSize, formatElapsedMs as formatElapsed } from '../shared/format';
