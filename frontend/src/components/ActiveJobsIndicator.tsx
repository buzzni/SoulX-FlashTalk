/**
 * ActiveJobsIndicator — TopBar pill that surfaces in-flight generation
 * jobs, eng-spec design-spec §2.
 *
 * Phase B step 19. This is the minimal functional shell:
 *   - greys out when no active job
 *   - red dot when ≥1 active (pending/streaming)
 *   - shows the count if >1
 *
 * Animations (220ms scale-in, conic-gradient ring, pulsing dot, ETA
 * sub-text), the multi-job panel, and the click-to-open dropdown
 * specified in design-spec §2-3 are deferred to a follow-up polish
 * commit. The shell here gives every wizard route the visibility hook
 * the spec requires; downstream design iteration replaces the
 * presentational layer without breaking the data wiring.
 */

import { useJobCacheStore } from '../stores/jobCacheStore';

export function ActiveJobsIndicator() {
  const jobs = useJobCacheStore((s) => s.jobs);
  const active = Object.values(jobs).filter(
    (e) =>
      e.snapshot != null &&
      (e.snapshot.state === 'pending' || e.snapshot.state === 'streaming'),
  );
  if (active.length === 0) return null;
  const label = active.length === 1 ? '생성 중' : `${active.length}개 생성 중`;
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
