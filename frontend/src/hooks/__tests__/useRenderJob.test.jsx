/**
 * useRenderJob — combines queueStore + progress subscription.
 * Tests cover basic stage/progress propagation, terminal detection,
 * and pollFailed surfacing.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../api/queue', () => ({
  fetchQueue: vi.fn().mockResolvedValue({
    running: [
      { task_id: 'task-live', status: 'running', type: 'generate', created_at: '2026-04-24T10:00:00', started_at: '2026-04-24T10:01:00' },
      // Second live task — the "new taskId" test swaps to this one and
      // expects useRenderJob to resubscribe. Must be non-terminal or
      // the terminal-skip optimization will (correctly) suppress the
      // subscribe.
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

let progressCb = null;
let progressUnsub = null;
vi.mock('../../api/progress', () => ({
  subscribeProgress: vi.fn((_taskId, cb) => {
    progressCb = cb;
    progressUnsub = vi.fn();
    return progressUnsub;
  }),
}));

import { useRenderJob } from '../useRenderJob';
import { __queueStoreInternals } from '../../stores/queueStore';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  __queueStoreInternals.reset();
  progressCb = null;
  progressUnsub = null;
});

beforeEach(() => {
  // stable epoch for elapsed-time math
});

describe('useRenderJob', () => {
  it('propagates stage/progress/message from the progress subscription', async () => {
    const { result } = renderHook(() => useRenderJob('task-live'));
    await waitFor(() => expect(progressCb).toBeTruthy());

    act(() => {
      progressCb({ stage: 'generating', progress: 0.42, message: '진행 중' });
    });
    expect(result.current.stage).toBe('generating');
    expect(result.current.progress).toBe(0.42);
    expect(result.current.message).toBe('진행 중');
    expect(result.current.isDone).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it('isDone turns true on terminal "complete" stage', async () => {
    const { result } = renderHook(() => useRenderJob('task-live'));
    await waitFor(() => expect(progressCb).toBeTruthy());
    act(() => progressCb({ stage: 'complete', progress: 1.0, message: '완료' }));
    expect(result.current.isDone).toBe(true);
    expect(result.current.isError).toBe(false);
  });

  it('pollFailed surfaces on subscription error', async () => {
    const { result } = renderHook(() => useRenderJob('task-live'));
    await waitFor(() => expect(progressCb).toBeTruthy());
    act(() => progressCb({ error: true }));
    expect(result.current.pollFailed).toBe(true);
  });

  it('unmount unsubscribes the progress listener', async () => {
    const { unmount } = renderHook(() => useRenderJob('task-live'));
    await waitFor(() => expect(progressCb).toBeTruthy());
    unmount();
    expect(progressUnsub).toHaveBeenCalled();
  });

  it('null taskId → no subscribe', () => {
    renderHook(() => useRenderJob(null));
    expect(progressCb).toBeNull();
  });

  it('re-render with a NEW taskId unsubscribes old + subscribes new', async () => {
    const { rerender } = renderHook(({ id }) => useRenderJob(id), { initialProps: { id: 'task-live' } });
    await waitFor(() => expect(progressCb).toBeTruthy());
    const firstUnsub = progressUnsub;
    rerender({ id: 'task-live-2' });
    await waitFor(() => expect(progressUnsub).not.toBe(firstUnsub));
    expect(firstUnsub).toHaveBeenCalled();
  });
});
