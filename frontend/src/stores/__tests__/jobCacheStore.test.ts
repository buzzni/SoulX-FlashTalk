/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
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
});
