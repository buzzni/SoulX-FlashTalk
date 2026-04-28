/**
 * jobSubscription — manages the SSE connection to /api/jobs/:id/events
 * for one or more interested components.
 *
 * Step 14 of streaming-resume Phase B. This module owns the connection
 * lifecycle (open / close / refcount); the actual fetch + SSE parsing
 * lands in step 15. Right now `_open` is a stub that immediately
 * resolves so step 14 commits as a buildable, testable surface without
 * wiring real network traffic.
 *
 * Contract:
 *   - subscribeToJob(jobId) returns a handle. Multiple subscribers to
 *     the same jobId share one underlying connection (refcount).
 *   - The handle's close() decrements; the LAST close() disconnects
 *     and resets the cache entry.
 *   - SSE events flow into useJobCacheStore actions; consumers read
 *     via useJobSnapshot (a thin React hook, see hooks/).
 *   - HMR cleanup: import.meta.hot.dispose disconnects everything so
 *     a Vite hot reload doesn't leave dangling EventSources.
 */

import { useJobCacheStore } from '../stores/jobCacheStore';

interface ActiveSubscription {
  jobId: string;
  refCount: number;
  /** Aborts the in-flight fetch + SSE parse loop. */
  abort: AbortController;
}

const _active = new Map<string, ActiveSubscription>();

/** Public handle returned to subscribers. close() is idempotent. */
export interface JobSubscriptionHandle {
  jobId: string;
  close: () => void;
}

/**
 * Subscribe to a job's event stream. Returns a handle whose close()
 * decrements the refcount; the connection lives until all handles are
 * closed.
 *
 * Step 15 will replace `_openConnection` with the real fetch + SSE
 * parser. Until then, this is a no-op connection that wires up the
 * cache lifecycle (beginLoading on open, reset on disconnect) so the
 * shape can be tested and the wider integration can build against it.
 */
export function subscribeToJob(jobId: string): JobSubscriptionHandle {
  const existing = _active.get(jobId);
  if (existing) {
    existing.refCount += 1;
    return makeHandle(jobId);
  }

  const abort = new AbortController();
  const sub: ActiveSubscription = { jobId, refCount: 1, abort };
  _active.set(jobId, sub);

  // Mark loading immediately — components reading the cache before
  // the snapshot frame arrives see isLoading=true.
  useJobCacheStore.getState().beginLoading(jobId);

  // Step 15: replace this stub with the actual fetch + SSE parse loop.
  _openConnection(jobId, abort.signal).catch((err) => {
    if (abort.signal.aborted) return;
    useJobCacheStore.getState().setError(jobId, errorMessage(err));
  });

  return makeHandle(jobId);
}

function makeHandle(jobId: string): JobSubscriptionHandle {
  let closed = false;
  return {
    jobId,
    close: () => {
      if (closed) return;
      closed = true;
      const sub = _active.get(jobId);
      if (!sub) return;
      sub.refCount -= 1;
      if (sub.refCount > 0) return;
      sub.abort.abort();
      _active.delete(jobId);
      // Drop the cache entry on final disconnect. A re-subscribe will
      // re-fetch the snapshot and rebuild — that's the eng-spec §3.2
      // race-free semantic.
      useJobCacheStore.getState().reset(jobId);
    },
  };
}

/** Step-15 stub. Replaced with real fetch('/api/jobs/:id/events') + SSE
 * parsing that drives setSnapshot / appendVariant / markReady etc. */
async function _openConnection(
  _jobId: string,
  _signal: AbortSignal,
): Promise<void> {
  // Intentionally empty until step 15. Returning a resolved promise
  // means `subscribeToJob` does not surface any error here; the cache
  // entry stays in `isLoading=true` indefinitely, which is fine
  // because no UI is wired to consume it yet (step 16-17 wire it).
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ────────────────────────────────────────────────────────────────────
// Internal — for tests + HMR cleanup.
// ────────────────────────────────────────────────────────────────────

/** Test-only: read the active subscription map. Not exported via the
 * package barrel; tests reach in directly. */
export function _testActiveCount(): number {
  return _active.size;
}

/** Test-only: drop everything. Mirrors what HMR cleanup does. */
export function _testReset(): void {
  for (const sub of _active.values()) {
    sub.abort.abort();
  }
  _active.clear();
  useJobCacheStore.getState().clear();
}

// HMR cleanup — Vite hot-reload of this module would otherwise leak
// every active subscription's AbortController (the new module copy
// can't see the old `_active` map). dispose() runs BEFORE the new
// module loads, so we can drain cleanly.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _testReset();
  });
}
