/**
 * Unit tests for wizardNav helpers — covers the pure formatter and the
 * sessionStorage-backed dispatch ownership tracking.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearDispatchInflight,
  clearDispatchSnapshot,
  clearDraftIfDispatched,
  formatDraftAge,
  getDispatchInflight,
  getDispatchSnapshot,
  markDispatched,
  setDispatchInflight,
} from '../wizardNav';
import { useWizardStore, INITIAL_WIZARD_STATE } from '../../stores/wizardStore';

describe('formatDraftAge', () => {
  const NOW = 1_700_000_000_000;

  it('returns "방금 전" for sub-minute diffs', () => {
    expect(formatDraftAge(NOW - 0, NOW)).toBe('방금 전');
    expect(formatDraftAge(NOW - 30_000, NOW)).toBe('방금 전');
    expect(formatDraftAge(NOW - 59_000, NOW)).toBe('방금 전');
  });

  it('returns N분 전 for sub-hour diffs', () => {
    expect(formatDraftAge(NOW - 60_000, NOW)).toBe('1분 전');
    expect(formatDraftAge(NOW - 23 * 60_000, NOW)).toBe('23분 전');
    expect(formatDraftAge(NOW - 59 * 60_000, NOW)).toBe('59분 전');
  });

  it('returns N시간 전 for sub-day diffs', () => {
    expect(formatDraftAge(NOW - 60 * 60_000, NOW)).toBe('1시간 전');
    expect(formatDraftAge(NOW - 23 * 60 * 60_000, NOW)).toBe('23시간 전');
  });

  it('switches to relative day labels past 24h', () => {
    expect(formatDraftAge(NOW - 24 * 60 * 60_000, NOW)).toBe('어제');
    expect(formatDraftAge(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe('3일 전');
    expect(formatDraftAge(NOW - 6 * 24 * 60 * 60_000, NOW)).toBe('6일 전');
  });

  it('rolls into weeks/months/years for distant timestamps', () => {
    const day = 24 * 60 * 60_000;
    expect(formatDraftAge(NOW - 7 * day, NOW)).toBe('1주 전');
    expect(formatDraftAge(NOW - 35 * day, NOW)).toBe('1개월 전');
    expect(formatDraftAge(NOW - 400 * day, NOW)).toBe('1년 전');
  });

  it('clamps negative diffs to "방금 전" instead of throwing', () => {
    expect(formatDraftAge(NOW + 5_000, NOW)).toBe('방금 전');
  });
});

describe('markDispatched / clearDraftIfDispatched', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useWizardStore.setState(INITIAL_WIZARD_STATE);
  });

  it('clears the wizard when the completed task matches the dispatched id', () => {
    useWizardStore.getState().setHost(useWizardStore.getState().host);
    expect(useWizardStore.getState().lastSavedAt).not.toBeNull();
    markDispatched('task-A');
    clearDraftIfDispatched('task-A');
    expect(useWizardStore.getState().lastSavedAt).toBeNull();
  });

  it('is a no-op when the completed task was not dispatched by this session', () => {
    useWizardStore.getState().setHost(useWizardStore.getState().host);
    const stamp = useWizardStore.getState().lastSavedAt;
    markDispatched('task-A');
    clearDraftIfDispatched('task-B');
    expect(useWizardStore.getState().lastSavedAt).toBe(stamp);
  });

  it('is a no-op when nothing was dispatched', () => {
    useWizardStore.getState().setHost(useWizardStore.getState().host);
    const stamp = useWizardStore.getState().lastSavedAt;
    clearDraftIfDispatched('task-A');
    expect(useWizardStore.getState().lastSavedAt).toBe(stamp);
  });
});

describe('dispatch snapshot — refresh idempotency', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('returns null before any dispatch', () => {
    expect(getDispatchSnapshot()).toBeNull();
  });

  it('roundtrips taskId + signature on the second mount', () => {
    // First mount writes the snapshot; refresh / new mount reads it.
    markDispatched('task-A', { signature: 'sig-1' });
    const snap = getDispatchSnapshot();
    expect(snap).not.toBeNull();
    expect(snap?.taskId).toBe('task-A');
    expect(snap?.signature).toBe('sig-1');
    expect(typeof snap?.at).toBe('number');
  });

  it('omits snapshot when no signature given (legacy callers stay legacy)', () => {
    markDispatched('task-A');
    expect(getDispatchSnapshot()).toBeNull();
  });

  it('clearDispatchSnapshot drops the snapshot but leaves justDispatched alone', () => {
    markDispatched('task-A', { signature: 'sig-1' });
    clearDispatchSnapshot();
    expect(getDispatchSnapshot()).toBeNull();
    // legacy auto-reset still works on the remaining justDispatched key
    expect(sessionStorage.getItem('showhost.justDispatched.v1')).toBe('task-A');
  });

  it('clearDraftIfDispatched wipes both keys when ids match', () => {
    markDispatched('task-A', { signature: 'sig-1' });
    clearDraftIfDispatched('task-A');
    expect(getDispatchSnapshot()).toBeNull();
    expect(sessionStorage.getItem('showhost.justDispatched.v1')).toBeNull();
  });

  it('returns null on malformed JSON in storage (forward-compat with v0 strings)', () => {
    // v0 sessions wrote a raw task_id string under the new key by mistake;
    // we must not crash, just treat it as absent.
    sessionStorage.setItem('showhost.dispatchSnapshot.v1', 'not-json');
    expect(getDispatchSnapshot()).toBeNull();
  });
});

describe('dispatch in-flight lock — refresh-during-POST guard', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('starts empty', () => {
    expect(getDispatchInflight()).toBeNull();
  });

  it('roundtrips signature so a peer mount sees the lock', () => {
    setDispatchInflight('sig-1');
    const lock = getDispatchInflight();
    expect(lock?.signature).toBe('sig-1');
    expect(typeof lock?.at).toBe('number');
  });

  it('clearDispatchInflight drops the lock', () => {
    setDispatchInflight('sig-1');
    clearDispatchInflight();
    expect(getDispatchInflight()).toBeNull();
  });

  it('TTL: stale lock (>60s old) is treated as absent', () => {
    // Hand-craft an aged entry; reading must auto-clear the stale row.
    sessionStorage.setItem(
      'showhost.dispatchInflight.v1',
      JSON.stringify({ signature: 'sig-1', at: Date.now() - 120_000 }),
    );
    expect(getDispatchInflight()).toBeNull();
    // Auto-cleared
    expect(sessionStorage.getItem('showhost.dispatchInflight.v1')).toBeNull();
  });

  it('returns null on malformed JSON without throwing', () => {
    sessionStorage.setItem('showhost.dispatchInflight.v1', '{"missing":"fields"}');
    expect(getDispatchInflight()).toBeNull();
  });

  it('signature mismatch is treated as live but not a match (caller decides)', () => {
    // The lock helpers don't compare; the caller does. We just round-trip.
    setDispatchInflight('sig-A');
    expect(getDispatchInflight()?.signature).toBe('sig-A');
  });
});
