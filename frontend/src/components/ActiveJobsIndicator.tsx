/**
 * ActiveJobsIndicator — TopBar pill surfacing in-flight generation
 * jobs (eng-spec design-spec §2).
 *
 * Minimal shell: greys out when no active job; red dot when ≥1
 * pending/streaming. Animations + multi-job dropdown + ETA sub-text
 * (design-spec §2-3) are TODOS.md polish.
 */

import { ACTIVE_STATES, useJobCacheStore } from '../stores/jobCacheStore';

/** Count active jobs as a primitive — components subscribing via
 * this selector only re-render when the count actually changes,
 * not on every cache mutation. */
const selectActiveCount = (s: ReturnType<typeof useJobCacheStore.getState>) =>
  Object.values(s.jobs).reduce(
    (n, e) =>
      e.snapshot && ACTIVE_STATES.has(e.snapshot.state) ? n + 1 : n,
    0,
  );

export function ActiveJobsIndicator() {
  const count = useJobCacheStore(selectActiveCount);
  if (count === 0) return null;
  const label = count === 1 ? '생성 중' : `${count}개 생성 중`;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 px-3 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-800 text-xs"
    >
      <span
        aria-hidden
        className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse"
      />
      <span>{label}</span>
    </div>
  );
}
