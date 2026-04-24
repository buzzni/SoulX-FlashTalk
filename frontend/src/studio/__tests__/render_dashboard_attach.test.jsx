/**
 * RenderDashboard attach mode — status-aware initial state.
 *
 * Post-router refactor: RenderDashboard only handles live-progress
 * (pending/running). Completed/error tasks redirect to /result/:taskId,
 * which we assert here by reading the MemoryRouter's current location.
 *
 * The old "provenance card reads meta/params" tests moved to
 * result_page.test.jsx — ProvenanceCard now lives on ResultPage, fed by
 * /api/results/{task_id}.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('../api.js', () => ({
  fetchQueue: vi.fn(),
  generateVideo: vi.fn(),
  subscribeProgress: vi.fn(() => () => {}),
  humanizeError: (e) => (e && e.message) || String(e),
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

function LocationSpy() {
  const loc = useLocation();
  return <div data-testid="landed">LANDED:{loc.pathname}</div>;
}

function renderInRouter(ui) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <QueueProvider>
        {ui}
        <LocationSpy />
      </QueueProvider>
    </MemoryRouter>
  );
}

describe('RenderDashboard attach mode — branching on queue status', () => {
  it('completed task: redirects to /result/:taskId without subscribing SSE', async () => {
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

    renderInRouter(
      <RenderDashboard state={baseState} attachToTaskId="done-1" onBack={() => {}} onReset={() => {}} />
    );

    await waitFor(() => {
      expect(screen.getByTestId('landed').textContent).toBe('LANDED:/result/done-1');
    });
    // Must NOT subscribe SSE for already-completed work.
    expect(subscribeProgress).not.toHaveBeenCalled();
  });

  it('error task: shows failure header, no SSE, stays on dashboard', async () => {
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

    renderInRouter(
      <RenderDashboard state={baseState} attachToTaskId="err-1" onBack={() => {}} onReset={() => {}} />
    );

    await waitFor(() => {
      expect(screen.getByText('만들기에 실패했어요')).toBeTruthy();
    });
    expect(subscribeProgress).not.toHaveBeenCalled();
    expect(screen.getByTestId('landed').textContent).toBe('LANDED:/');
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

    renderInRouter(
      <RenderDashboard state={baseState} attachToTaskId="run-1" onBack={() => {}} onReset={() => {}} />
    );

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

    renderInRouter(
      <RenderDashboard state={baseState} attachToTaskId="pend-1" onBack={() => {}} onReset={() => {}} />
    );

    await waitFor(() => {
      expect(subscribeProgress).toHaveBeenCalledWith('pend-1', expect.any(Function));
    });
    expect(screen.getByText('영상 만드는 중이에요')).toBeTruthy();
  });
});
