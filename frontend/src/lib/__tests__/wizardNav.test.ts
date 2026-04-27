/**
 * Unit tests for wizardNav helpers — covers the pure formatter and the
 * sessionStorage-backed dispatch ownership tracking.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearDraftIfDispatched,
  formatDraftAge,
  markDispatched,
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
