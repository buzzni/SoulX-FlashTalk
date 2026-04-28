/**
 * jobSubscription — manages the SSE connection to /api/jobs/:id/events
 * for one or more interested components.
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

import { API_BASE, getAuthHeaders } from './http';
import { parseRichSSEStream, type SSEFrame } from './sseParser';
import {
  TERMINAL_STATES,
  type JobSnapshot,
  type JobVariant,
  useJobCacheStore,
} from '../stores/jobCacheStore';

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

/** Open the SSE connection and drive cache mutations. Reconnects on
 * transient failure, carrying Last-Event-ID so the server skips the
 * snapshot frame on resume (eng-spec §3.2 race-free handshake).
 *
 * Backoff: jittered 1-5s between reconnects. Aborted signal exits the
 * loop without scheduling another retry. Terminal events (done /
 * fatal / cancelled) close the connection cleanly and stop the loop. */
async function _openConnection(
  jobId: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const lastSeq = useJobCacheStore.getState().jobs[jobId]?.lastSeq ?? 0;
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...getAuthHeaders(),
    };
    if (lastSeq > 0) {
      headers['Last-Event-ID'] = String(lastSeq);
    }
    let res: Response;
    try {
      res = await fetch(
        `${API_BASE}/api/jobs/${encodeURIComponent(jobId)}/events`,
        { headers, signal },
      );
    } catch {
      if (signal.aborted) return;
      // Network error — retry after backoff.
      await sleep(jitter(1000, 5000), signal);
      continue;
    }
    if (!res.ok) {
      // 401/403/404/429 are all terminal for this subscription — surface
      // and stop. Other 5xx may be transient; retry.
      if ([401, 403, 404, 429].includes(res.status)) {
        useJobCacheStore.getState().setError(
          jobId,
          `구독 실패 (${res.status})`,
        );
        return;
      }
      await sleep(jitter(1000, 5000), signal);
      continue;
    }
    const terminated = await _drive(jobId, res, signal);
    if (terminated || signal.aborted) return;
    // Connection dropped without a terminal event — reconnect.
    await sleep(jitter(500, 2000), signal);
  }
}

/** Apply each SSE frame to the cache. Returns true when a terminal
 * event lands (or the server closes the stream after a terminal-state
 * snapshot — see backend's `event_generator` in app.py). */
async function _drive(
  jobId: string,
  res: Response,
  signal: AbortSignal,
): Promise<boolean> {
  let sawTerminal = false;
  for await (const frame of parseRichSSEStream(res, signal)) {
    if (signal.aborted) return false;
    if (_applyFrame(jobId, frame)) {
      sawTerminal = true;
    }
  }
  return sawTerminal;
}

/** Translate one parsed SSE frame into a cache action. Returns true if
 * the frame was a terminal event (caller stops the reconnect loop). */
function _applyFrame(jobId: string, frame: SSEFrame): boolean {
  const seq = frame.id ?? 0;
  const cache = useJobCacheStore.getState();
  switch (frame.event) {
    case 'snapshot': {
      cache.setSnapshot(jobId, frame.data as JobSnapshot, seq);
      // The endpoint closes the stream right after the snapshot if
      // the snap is already in a terminal state — treat it as such.
      const snap = frame.data as JobSnapshot;
      return TERMINAL_STATES.has(snap.state);
    }
    case 'candidate': {
      const payload = frame.data as { variant?: JobVariant };
      const variant = payload?.variant ?? (frame.data as JobVariant);
      cache.appendVariant(jobId, variant, seq);
      return false;
    }
    case 'done': {
      const payload = frame.data as {
        batch_id?: string | null;
        prev_selected_image_id?: string | null;
      };
      cache.markReady(jobId, {
        batch_id: payload?.batch_id ?? null,
        prev_selected_image_id: payload?.prev_selected_image_id ?? null,
        seq,
      });
      return true;
    }
    case 'fatal': {
      const payload = frame.data as { error?: string };
      cache.markFailed(jobId, payload?.error ?? 'unknown error', seq);
      return true;
    }
    case 'cancelled': {
      cache.markCancelled(jobId, seq);
      return true;
    }
    default:
      // Unknown event types are tolerated — backend or frontend may
      // ship a new event type before the other side catches up.
      return false;
  }
}

function jitter(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
