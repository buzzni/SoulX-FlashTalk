/**
 * RenderDashboard attach mode — status-aware initial state.
 *
 * Regression: clicking a completed task from QueueStatus used to show
 * "대기열 등록 중" forever (default stage = 'queued', no SSE progress
 * because the task had already finished). Fix: branch on queueEntry.status
 * the moment the queue snapshot is available — completed tasks jump
 * straight to the finished video without replaying SSE stages.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';

vi.mock('../api.js', () => ({
  fetchQueue: vi.fn(),
  generateVideo: vi.fn(),
  subscribeProgress: vi.fn(() => () => {}),
  humanizeError: (e) => (e && e.message) || String(e),
  // RenderHistory mounts inside RenderDashboard during non-done states and
  // imports fetchHistory — stub it out so the test doesn't blow up.
  fetchHistory: vi.fn().mockResolvedValue({ total: 0, videos: [] }),
}));

import { fetchQueue, subscribeProgress } from '../api.js';
import RenderDashboard from '../RenderDashboard.jsx';
import { QueueProvider } from '../QueueContext.jsx';

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

const baseState = {
  voice: { generatedAudioPath: null, uploadedAudio: null, source: 'tts', voiceName: null },
  resolution: { key: '448p', label: '448p', width: 448, height: 768, size: '8MB' },
  host: { mode: 'text', selectedSeed: 10 },
  products: [],
  background: { source: 'preset' },
  composition: {},
};

function withProvider(ui) {
  return <QueueProvider>{ui}</QueueProvider>;
}

describe('RenderDashboard attach mode — branching on queue status', () => {
  it('completed task: skips SSE, shows "완성된 영상" immediately', async () => {
    fetchQueue.mockResolvedValue({
      running: [],
      pending: [],
      recent: [{
        task_id: 'done-1',
        type: 'generate',
        status: 'completed',
        started_at: '2026-04-23T10:00:00',
        completed_at: '2026-04-23T10:03:00',
        created_at: '2026-04-23T09:59:00',
      }],
      total_running: 0,
      total_pending: 0,
    });

    render(withProvider(
      <RenderDashboard state={baseState} attachToTaskId="done-1" onBack={() => {}} onReset={() => {}} />
    ));

    await waitFor(() => {
      expect(screen.getByText('영상이 완성됐어요!')).toBeTruthy();
    });
    // Must NOT subscribe SSE for already-completed work (no stage replay).
    expect(subscribeProgress).not.toHaveBeenCalled();
  });

  it('error task: shows failure header, no SSE', async () => {
    fetchQueue.mockResolvedValue({
      running: [],
      pending: [],
      recent: [{
        task_id: 'err-1',
        type: 'generate',
        status: 'error',
        error: 'simulated failure',
        created_at: '2026-04-23T09:59:00',
        completed_at: '2026-04-23T10:00:00',
      }],
      total_running: 0,
      total_pending: 0,
    });

    render(withProvider(
      <RenderDashboard state={baseState} attachToTaskId="err-1" onBack={() => {}} onReset={() => {}} />
    ));

    await waitFor(() => {
      expect(screen.getByText('만들기에 실패했어요')).toBeTruthy();
    });
    expect(subscribeProgress).not.toHaveBeenCalled();
  });

  it('running task: subscribes SSE for live updates', async () => {
    fetchQueue.mockResolvedValue({
      running: [{
        task_id: 'run-1',
        type: 'generate',
        status: 'running',
        started_at: '2026-04-23T10:00:00',
        created_at: '2026-04-23T09:59:00',
      }],
      pending: [],
      recent: [],
      total_running: 1,
      total_pending: 0,
    });

    render(withProvider(
      <RenderDashboard state={baseState} attachToTaskId="run-1" onBack={() => {}} onReset={() => {}} />
    ));

    await waitFor(() => {
      expect(subscribeProgress).toHaveBeenCalledWith('run-1', expect.any(Function));
    });
  });

  it('pending task: header reads "영상 만드는 중", SSE still subscribed', async () => {
    fetchQueue.mockResolvedValue({
      running: [],
      pending: [{
        task_id: 'pend-1',
        type: 'generate',
        status: 'pending',
        created_at: '2026-04-23T10:02:00',
      }],
      recent: [],
      total_running: 0,
      total_pending: 1,
    });

    render(withProvider(
      <RenderDashboard state={baseState} attachToTaskId="pend-1" onBack={() => {}} onReset={() => {}} />
    ));

    await waitFor(() => {
      expect(subscribeProgress).toHaveBeenCalledWith('pend-1', expect.any(Function));
    });
    expect(screen.getByText('영상 만드는 중이에요')).toBeTruthy();
  });
});
