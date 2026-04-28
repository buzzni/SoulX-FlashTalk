/**
 * jobCacheStore — client-side cache of /api/jobs/:id snapshots, kept
 * fresh by the SSE subscription module (frontend/src/api/jobSubscription.ts).
 *
 * Step 14 of streaming-resume Phase B (eng-spec §3 + §6). The wizard's
 * v9 schema treats generation as `attached(jobId)` — a thin handle. Any
 * UI that wants the actual variants/state for that job reads from this
 * cache. The cache is hydrated by:
 *   1. The SSE 'snapshot' frame on subscribe (eng-spec §3.2 race-free
 *      handshake).
 *   2. Subsequent 'candidate' / 'done' / 'fatal' / 'cancelled' frames
 *      with monotonic seq numbers.
 *
 * Out-of-order seq protection: every mutation action takes a seq and
 * rejects it if seq <= lastSeq. The pubsub guarantees monotonic seq per
 * job, but a misbehaving network or a buffered redelivery shouldn't
 * silently overwrite newer state.
 *
 * Terminal-state lock: once a job lands in 'ready' / 'failed' /
 * 'cancelled', subsequent non-terminal mutations are dropped. The
 * server's conditional updates already guarantee this on the data
 * layer; the cache mirrors the invariant for defense-in-depth.
 *
 * Eviction: not implemented — a single user session typically holds <20
 * jobs, well under any memory pressure. LRU can be added later if
 * needed; the surface (`reset(jobId)`, `clear()`) is in place.
 */

import { create } from 'zustand';

// ────────────────────────────────────────────────────────────────────
// Wire types — match the backend's JobSnapshot Pydantic model exactly.
// snake_case is preserved on the wire; the cache stores raw shape so
// no per-frame translation is needed.
// ────────────────────────────────────────────────────────────────────

export type JobKind = 'host' | 'composite';
export type JobState =
  | 'pending'
  | 'streaming'
  | 'ready'
  | 'failed'
  | 'cancelled';

const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  'ready',
  'failed',
  'cancelled',
]);

/** Variant shape carried in `JobSnapshot.variants[]`. The fields are
 * provider-defined (host vs composite handlers can return different
 * keys); the cache treats them as opaque dicts and lets consumers
 * narrow at usage time. */
export interface JobVariant {
  image_id?: string;
  path?: string;
  url?: string;
  seed?: number;
  [key: string]: unknown;
}

export interface JobSnapshot {
  id: string;
  user_id: string;
  kind: JobKind;
  state: JobState;
  variants: JobVariant[];
  prev_selected_image_id: string | null;
  batch_id: string | null;
  error: string | null;
  input_hash: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  heartbeat_at?: string | null;
}

export interface JobCacheEntry {
  snapshot: JobSnapshot | null;
  /** Highest seq applied to `snapshot`. New events with seq <= lastSeq
   * are rejected. The 'snapshot' frame's seq becomes the initial
   * baseline — events from the SSE drain pass through with seq strictly
   * greater. */
  lastSeq: number;
  /** True between subscribe-start and the first snapshot frame. */
  isLoading: boolean;
  /** Connection-level error (network, auth) — distinct from
   * snapshot.error which carries the server's generation failure. */
  error: string | null;
}

interface JobCacheState {
  jobs: Record<string, JobCacheEntry>;

  // ── Hydration / connection lifecycle ────────────────────────────
  /** Mark the entry as actively subscribing. Idempotent. */
  beginLoading: (jobId: string) => void;
  /** Connection-level failure — keeps any prior snapshot, sets error. */
  setError: (jobId: string, error: string) => void;
  /** Replace the entire snapshot (used by the SSE 'snapshot' frame).
   * `seq` is the server's seq_at_subscribe; future events must have
   * strictly greater seq to apply. */
  setSnapshot: (jobId: string, snapshot: JobSnapshot, seq: number) => void;

  // ── Per-event mutations ─────────────────────────────────────────
  /** Append a variant from a 'candidate' SSE frame. */
  appendVariant: (jobId: string, variant: JobVariant, seq: number) => void;
  /** Apply a 'done' event — state→ready + batch_id + prev_selected. */
  markReady: (
    jobId: string,
    args: {
      batch_id: string | null;
      prev_selected_image_id: string | null;
      seq: number;
    },
  ) => void;
  /** Apply a 'fatal' event — state→failed + error message. */
  markFailed: (jobId: string, error: string, seq: number) => void;
  /** Apply a 'cancelled' event — state→cancelled. */
  markCancelled: (jobId: string, seq: number) => void;

  // ── Bookkeeping ─────────────────────────────────────────────────
  /** Drop the entry — used by jobSubscription on final disconnect. */
  reset: (jobId: string) => void;
  /** Drop everything (HMR cleanup, sign-out). */
  clear: () => void;
}

// Helper — produces a no-op entry shape so callers don't have to
// special-case undefined.
function emptyEntry(): JobCacheEntry {
  return { snapshot: null, lastSeq: 0, isLoading: false, error: null };
}

// Helper — read the current entry, falling back to empty.
function read(
  state: JobCacheState,
  jobId: string,
): JobCacheEntry {
  return state.jobs[jobId] ?? emptyEntry();
}

export const useJobCacheStore = create<JobCacheState>((set) => ({
  jobs: {},

  beginLoading: (jobId) =>
    set((s) => ({
      jobs: {
        ...s.jobs,
        [jobId]: { ...read(s, jobId), isLoading: true, error: null },
      },
    })),

  setError: (jobId, error) =>
    set((s) => ({
      jobs: {
        ...s.jobs,
        [jobId]: { ...read(s, jobId), isLoading: false, error },
      },
    })),

  setSnapshot: (jobId, snapshot, seq) =>
    set((s) => ({
      jobs: {
        ...s.jobs,
        [jobId]: {
          snapshot,
          lastSeq: seq,
          isLoading: false,
          error: null,
        },
      },
    })),

  appendVariant: (jobId, variant, seq) =>
    set((s) => {
      const entry = read(s, jobId);
      // Out-of-order → drop.
      if (seq <= entry.lastSeq) return s;
      // No snapshot yet → can't apply (handshake invariant). Wait for
      // the snapshot frame; subsequent events will be replayed by the
      // subscriber's logic if needed.
      if (!entry.snapshot) return s;
      // Terminal lock — don't let a stale candidate sneak past a
      // ready/failed/cancelled snapshot.
      if (TERMINAL_STATES.has(entry.snapshot.state)) return s;
      return {
        jobs: {
          ...s.jobs,
          [jobId]: {
            ...entry,
            snapshot: {
              ...entry.snapshot,
              variants: [...entry.snapshot.variants, variant],
              state: 'streaming',
            },
            lastSeq: seq,
          },
        },
      };
    }),

  markReady: (jobId, { batch_id, prev_selected_image_id, seq }) =>
    set((s) => {
      const entry = read(s, jobId);
      if (seq <= entry.lastSeq) return s;
      if (!entry.snapshot) return s;
      if (TERMINAL_STATES.has(entry.snapshot.state)) return s;
      return {
        jobs: {
          ...s.jobs,
          [jobId]: {
            ...entry,
            snapshot: {
              ...entry.snapshot,
              state: 'ready',
              batch_id,
              prev_selected_image_id,
            },
            lastSeq: seq,
          },
        },
      };
    }),

  markFailed: (jobId, error, seq) =>
    set((s) => {
      const entry = read(s, jobId);
      if (seq <= entry.lastSeq) return s;
      if (!entry.snapshot) return s;
      if (TERMINAL_STATES.has(entry.snapshot.state)) return s;
      return {
        jobs: {
          ...s.jobs,
          [jobId]: {
            ...entry,
            snapshot: { ...entry.snapshot, state: 'failed', error },
            lastSeq: seq,
          },
        },
      };
    }),

  markCancelled: (jobId, seq) =>
    set((s) => {
      const entry = read(s, jobId);
      if (seq <= entry.lastSeq) return s;
      if (!entry.snapshot) return s;
      if (TERMINAL_STATES.has(entry.snapshot.state)) return s;
      return {
        jobs: {
          ...s.jobs,
          [jobId]: {
            ...entry,
            snapshot: { ...entry.snapshot, state: 'cancelled' },
            lastSeq: seq,
          },
        },
      };
    }),

  reset: (jobId) =>
    set((s) => {
      if (!(jobId in s.jobs)) return s;
      const next = { ...s.jobs };
      delete next[jobId];
      return { jobs: next };
    }),

  clear: () => set({ jobs: {} }),
}));

/** Selector helper — returns an empty entry instead of undefined so
 * components don't have to null-check on first render. */
export function selectJobEntry(jobId: string | null) {
  return (s: JobCacheState): JobCacheEntry =>
    jobId ? (s.jobs[jobId] ?? emptyEntry()) : emptyEntry();
}
