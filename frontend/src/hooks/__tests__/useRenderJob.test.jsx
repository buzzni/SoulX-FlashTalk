/**
 * useRenderJob — combines queueStore + TanStack Query progress.
 * Tests cover stage/progress propagation, terminal detection, and
 * pollFailed surfacing. Lane E swapped subscribeProgress out for
 * useTaskProgress (TQ); we mock that hook directly so tests can
 * drive it deterministically without standing up a QueryClient.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../api/queue', () => ({
  fetchQueue: vi.fn().mockResolvedValue({
    running: [
      { task_id: 'task-live', status: 'running', type: 'generate', created_at: '2026-04-24T10:00:00', started_at: '2026-04-24T10:01:00' },
      { task_id: 'task-live-2', status: 'running', type: 'generate', created_at: '2026-04-24T10:10:00', started_at: '2026-04-24T10:11:00' },
    ],
    pending: [],
    recent: [
      { task_id: 'task-done', status: 'completed', type: 'generate', created_at: '2026-04-24T09:00:00', started_at: '2026-04-24T09:01:00', completed_at: '2026-04-24T09:05:00' },
    ],
    total_running: 2,
    total_pending: 0,
  }),
  cancelQueuedTask: vi.fn(),
}));

// useTaskProgress mock — tests drive state via setProgressState() and
// inspect lastEnabledFor() to assert the gating logic.
let lastEnabledTaskId = null;
let progressState = { data: undefined, failureCount: 0, isError: false };

function setProgressState(next) {
  progressState = { ...progressState, ...next };
}

vi.mock('../../api/queries/use-task-progress', () => ({
  useTaskProgress: (taskId, opts) => {
    if (opts?.enabled !== false && taskId) {
      lastEnabledTaskId = taskId;
    }
    return {
      data: progressState.data,
      isError: progressState.isError,
      failureCount: progressState.failureCount,
    };
  },
}));

import { useRenderJob } from '../useRenderJob';
import { __queueStoreInternals } from '../../stores/queueStore';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  __queueStoreInternals.reset();
  lastEnabledTaskId = null;
  progressState = { data: undefined, failureCount: 0, isError: false };
});

beforeEach(() => {
  // stable epoch for elapsed-time math
});

describe('useRenderJob', () => {
  it('propagates stage/progress/message from the TQ task-state query', async () => {
    setProgressState({ data: { task_id: 'task-live', stage: 'generating', progress: 0.42, message: '진행 중' } });
    const { result, rerender } = renderHook(() => useRenderJob('task-live'));
    await waitFor(() => expect(lastEnabledTaskId).toBe('task-live'));

    rerender();
    expect(result.current.stage).toBe('generating');
    expect(result.current.progress).toBe(0.42);
    expect(result.current.message).toBe('진행 중');
    expect(result.current.isDone).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it('isDone turns true on terminal "complete" stage', async () => {
    setProgressState({ data: { task_id: 'task-live', stage: 'complete', progress: 1.0, message: '완료' } });
    const { result } = renderHook(() => useRenderJob('task-live'));
    await waitFor(() => expect(lastEnabledTaskId).toBe('task-live'));
    expect(result.current.isDone).toBe(true);
    expect(result.current.isError).toBe(false);
  });

  it('pollFailed surfaces when TQ exhausts retries (failureCount>=3 + isError)', async () => {
    setProgressState({ failureCount: 3, isError: true });
    const { result } = renderHook(() => useRenderJob('task-live'));
    await waitFor(() => expect(lastEnabledTaskId).toBe('task-live'));
    expect(result.current.pollFailed).toBe(true);
    expect(result.current.isError).toBe(true);
  });

  it('null taskId → never enables the query', () => {
    renderHook(() => useRenderJob(null));
    expect(lastEnabledTaskId).toBeNull();
  });

  it('switching to a NEW taskId enables the query for the new id', async () => {
    const { rerender } = renderHook(({ id }) => useRenderJob(id), { initialProps: { id: 'task-live' } });
    await waitFor(() => expect(lastEnabledTaskId).toBe('task-live'));
    rerender({ id: 'task-live-2' });
    await waitFor(() => expect(lastEnabledTaskId).toBe('task-live-2'));
  });

  it('terminal queue entry → query stays disabled', async () => {
    const { result } = renderHook(() => useRenderJob('task-done'));
    // The mock asserts what *would* have been enabled; for the terminal
    // skip path we expect lastEnabledTaskId to never flip to task-done.
    await waitFor(() => expect(result.current.entry?.task_id).toBe('task-done'));
    expect(lastEnabledTaskId).not.toBe('task-done');
  });
});
