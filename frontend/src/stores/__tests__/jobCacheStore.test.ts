/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  EMPTY_ENTRY,
  selectJobEntry,
  type JobSnapshot,
  useJobCacheStore,
} from '../jobCacheStore';

const makeSnapshot = (overrides: Partial<JobSnapshot> = {}): JobSnapshot => ({
  id: 'job-1',
  user_id: 'u1',
  kind: 'host',
  state: 'streaming',
  variants: [],
  prev_selected_image_id: null,
  batch_id: null,
  error: null,
  input_hash: null,
  ...overrides,
});

describe('jobCacheStore', () => {
  beforeEach(() => {
    useJobCacheStore.getState().clear();
  });

  it('begins loading and surfaces empty entry until snapshot lands', () => {
    useJobCacheStore.getState().beginLoading('job-1');
    const entry = useJobCacheStore.getState().jobs['job-1']!;
    expect(entry.isLoading).toBe(true);
    expect(entry.snapshot).toBeNull();
    expect(entry.lastSeq).toBe(0);
  });

  it('setSnapshot replaces and seeds lastSeq', () => {
    const snap = makeSnapshot({ state: 'streaming' });
    useJobCacheStore.getState().setSnapshot('job-1', snap, 7);
    const entry = useJobCacheStore.getState().jobs['job-1']!;
    expect(entry.snapshot).toEqual(snap);
    expect(entry.lastSeq).toBe(7);
    expect(entry.isLoading).toBe(false);
  });

  // ── seq monotonicity ────────────────────────────────────────────

  it('appendVariant rejects out-of-order seq', () => {
    useJobCacheStore.getState().setSnapshot('job-1', makeSnapshot(), 10);
    useJobCacheStore.getState().appendVariant(
      'job-1',
      { image_id: 'v1', path: '/p/v1.png' },
      9, // older than snapshot's seq
    );
    const entry = useJobCacheStore.getState().jobs['job-1']!;
    expect(entry.snapshot?.variants).toEqual([]);
    expect(entry.lastSeq).toBe(10);
  });

  it('appendVariant accepts strictly newer seq', () => {
    useJobCacheStore.getState().setSnapshot('job-1', makeSnapshot(), 10);
    useJobCacheStore.getState().appendVariant(
      'job-1',
      { image_id: 'v1', path: '/p/v1.png' },
      11,
    );
    useJobCacheStore.getState().appendVariant(
      'job-1',
      { image_id: 'v2', path: '/p/v2.png' },
      12,
    );
    const entry = useJobCacheStore.getState().jobs['job-1']!;
    expect(entry.snapshot?.variants).toHaveLength(2);
    expect(entry.snapshot?.state).toBe('streaming');
    expect(entry.lastSeq).toBe(12);
  });

  // ── terminal-state lock ─────────────────────────────────────────

  it('appendVariant is rejected after markReady', () => {
    useJobCacheStore.getState().setSnapshot('job-1', makeSnapshot(), 5);
    useJobCacheStore.getState().markReady('job-1', {
      batch_id: 'b1',
      prev_selected_image_id: null,
      seq: 6,
    });
    useJobCacheStore.getState().appendVariant(
      'job-1',
      { image_id: 'late', path: '/p/late.png' },
      7,
    );
    const entry = useJobCacheStore.getState().jobs['job-1']!;
    expect(entry.snapshot?.state).toBe('ready');
    expect(entry.snapshot?.variants).toEqual([]); // 'late' didn't slip in
  });

  it('markFailed rejected after markCancelled (cancel wins)', () => {
    useJobCacheStore.getState().setSnapshot('job-1', makeSnapshot(), 5);
    useJobCacheStore.getState().markCancelled('job-1', 6);
    useJobCacheStore.getState().markFailed('job-1', 'GPU OOM', 7);
    const entry = useJobCacheStore.getState().jobs['job-1']!;
    expect(entry.snapshot?.state).toBe('cancelled');
    expect(entry.snapshot?.error).toBeNull();
  });

  // ── pre-snapshot guard ─────────────────────────────────────────

  it('appendVariant is dropped when no snapshot has landed', () => {
    useJobCacheStore.getState().beginLoading('job-1');
    useJobCacheStore.getState().appendVariant(
      'job-1',
      { image_id: 'v1' },
      5,
    );
    const entry = useJobCacheStore.getState().jobs['job-1']!;
    expect(entry.snapshot).toBeNull();
    // lastSeq stays 0 — the event was not applied.
    expect(entry.lastSeq).toBe(0);
  });

  // ── markReady ───────────────────────────────────────────────────

  it('markReady sets state, batch_id, prev_selected_image_id', () => {
    useJobCacheStore.getState().setSnapshot('job-1', makeSnapshot(), 5);
    useJobCacheStore.getState().markReady('job-1', {
      batch_id: 'b-x',
      prev_selected_image_id: 'old-img',
      seq: 6,
    });
    const entry = useJobCacheStore.getState().jobs['job-1']!;
    expect(entry.snapshot?.state).toBe('ready');
    expect(entry.snapshot?.batch_id).toBe('b-x');
    expect(entry.snapshot?.prev_selected_image_id).toBe('old-img');
  });

  // ── markFailed / markCancelled ──────────────────────────────────

  it('markFailed sets state=failed and error', () => {
    useJobCacheStore.getState().setSnapshot('job-1', makeSnapshot(), 5);
    useJobCacheStore.getState().markFailed('job-1', 'GPU OOM', 6);
    const entry = useJobCacheStore.getState().jobs['job-1']!;
    expect(entry.snapshot?.state).toBe('failed');
    expect(entry.snapshot?.error).toBe('GPU OOM');
  });

  it('markCancelled sets state=cancelled', () => {
    useJobCacheStore.getState().setSnapshot('job-1', makeSnapshot(), 5);
    useJobCacheStore.getState().markCancelled('job-1', 6);
    const entry = useJobCacheStore.getState().jobs['job-1']!;
    expect(entry.snapshot?.state).toBe('cancelled');
  });

  // ── per-job isolation ──────────────────────────────────────────

  it('events for job-A do not affect job-B', () => {
    useJobCacheStore.getState().setSnapshot('job-A', makeSnapshot({ id: 'job-A' }), 5);
    useJobCacheStore.getState().setSnapshot('job-B', makeSnapshot({ id: 'job-B' }), 5);
    useJobCacheStore.getState().appendVariant('job-A', { image_id: 'v1' }, 6);
    const a = useJobCacheStore.getState().jobs['job-A']!;
    const b = useJobCacheStore.getState().jobs['job-B']!;
    expect(a.snapshot?.variants).toHaveLength(1);
    expect(b.snapshot?.variants).toHaveLength(0);
  });

  // ── setError + reset + clear ───────────────────────────────────

  it('setError preserves prior snapshot but flips error', () => {
    useJobCacheStore.getState().setSnapshot('job-1', makeSnapshot(), 5);
    useJobCacheStore.getState().setError('job-1', 'connection lost');
    const entry = useJobCacheStore.getState().jobs['job-1']!;
    expect(entry.error).toBe('connection lost');
    expect(entry.snapshot).not.toBeNull();
  });

  it('reset removes the entry', () => {
    useJobCacheStore.getState().setSnapshot('job-1', makeSnapshot(), 5);
    useJobCacheStore.getState().reset('job-1');
    expect(useJobCacheStore.getState().jobs['job-1']).toBeUndefined();
  });

  it('clear empties the whole store', () => {
    useJobCacheStore.getState().setSnapshot('job-1', makeSnapshot(), 5);
    useJobCacheStore.getState().setSnapshot('job-2', makeSnapshot(), 5);
    useJobCacheStore.getState().clear();
    expect(useJobCacheStore.getState().jobs).toEqual({});
  });

  // ── Regression nets for /simplify P1 fixes ──────────────────────
  //
  // Both behaviors are perf-critical: zustand's Object.is comparator
  // re-renders every selector subscriber when the returned reference
  // changes. A regression in either is silent — all 14 logical-state
  // tests above pass — but every component using useJobSnapshot for a
  // missing or unchanged-snapshot job thrashes on every store write.

  it('selectJobEntry returns the same EMPTY_ENTRY across calls (no re-render storm)', () => {
    const sel = selectJobEntry('not-cached');
    const s1 = useJobCacheStore.getState();
    // An unrelated mutation must not change the empty-entry reference
    // returned for a different jobId.
    useJobCacheStore.getState().setSnapshot('other', makeSnapshot(), 1);
    const s2 = useJobCacheStore.getState();
    expect(sel(s1)).toBe(EMPTY_ENTRY);
    expect(sel(s2)).toBe(EMPTY_ENTRY);
    expect(sel(s1)).toBe(sel(s2));
  });

  it('selectJobEntry(null) === EMPTY_ENTRY (stable null path)', () => {
    const sel = selectJobEntry(null);
    expect(sel(useJobCacheStore.getState())).toBe(EMPTY_ENTRY);
  });

  it('setSnapshot with the same seq is a no-op — store reference stays stable', () => {
    const snap = makeSnapshot();
    useJobCacheStore.getState().setSnapshot('job-1', snap, 7);
    const ref1 = useJobCacheStore.getState().jobs;
    useJobCacheStore.getState().setSnapshot('job-1', snap, 7); // replay
    const ref2 = useJobCacheStore.getState().jobs;
    expect(ref1).toBe(ref2);
  });

  it('setSnapshot at seq=0 lands when no prior snapshot exists', () => {
    // The idempotent guard (`seq <= entry.lastSeq && entry.snapshot !== null`)
    // must NOT block the initial snapshot when the cache is empty —
    // the entry's lastSeq starts at 0 and the very first snapshot can
    // legitimately land at seq=0 (e.g., a job with no events yet).
    useJobCacheStore.getState().beginLoading('job-1');
    useJobCacheStore.getState().setSnapshot('job-1', makeSnapshot(), 0);
    expect(useJobCacheStore.getState().jobs['job-1']!.snapshot).not.toBeNull();
  });
});
