/**
 * QueueStatus — running/pending items are clickable and forward task_id to
 * onTaskClick (used by HostStudio to switch to RenderDashboard in attach mode).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../api.js', () => ({
  fetchQueue: vi.fn(),
  cancelQueuedTask: vi.fn(),
  humanizeError: (e) => (e && e.message) || String(e),
}));

import { fetchQueue, cancelQueuedTask } from '../api.js';
import QueueStatus from '../QueueStatus.jsx';
import { QueueProvider } from '../QueueContext.jsx';

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

beforeEach(() => {
  vi.useFakeTimers();
  fetchQueue.mockResolvedValue({
    running: [{ task_id: 'run-1', type: 'generate', label: 'running script', started_at: '2026-04-23T10:00:00' }],
    pending: [
      { task_id: 'pend-1', type: 'generate', label: 'first pending', created_at: '2026-04-23T10:01:00' },
      { task_id: 'pend-2', type: 'conversation', label: 'second pending', created_at: '2026-04-23T10:02:00' },
    ],
    recent: [],
    total_running: 1,
    total_pending: 2,
  });
});

async function renderAndExpand(props = {}) {
  const result = render(
    <QueueProvider>
      <QueueStatus {...props} />
    </QueueProvider>
  );
  await act(async () => { await Promise.resolve(); });
  // Click the floating "큐" button to expand
  fireEvent.click(screen.getByTitle('작업 큐 상태'));
  return result;
}

describe('QueueStatus click-to-navigate', () => {
  it('calls onTaskClick(taskId) when a running item is clicked', async () => {
    const onTaskClick = vi.fn();
    await renderAndExpand({ onTaskClick });
    fireEvent.click(screen.getByText('running script'));
    expect(onTaskClick).toHaveBeenCalledWith('run-1');
  });

  it('calls onTaskClick(taskId) when a pending item is clicked', async () => {
    const onTaskClick = vi.fn();
    await renderAndExpand({ onTaskClick });
    fireEvent.click(screen.getByText('first pending'));
    expect(onTaskClick).toHaveBeenCalledWith('pend-1');
  });

  it('items are disabled when no onTaskClick handler is supplied', async () => {
    await renderAndExpand({});
    const btn = screen.getByText('running script').closest('button');
    expect(btn.disabled).toBe(true);
  });

  it('pending row exposes an enabled cancel button that calls cancelQueuedTask', async () => {
    cancelQueuedTask.mockResolvedValue({ message: 'cancelled' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await renderAndExpand({});
    const cancelBtns = screen.getAllByLabelText('작업 취소');
    // Order: running first (disabled), then 2 pending (enabled)
    expect(cancelBtns).toHaveLength(3);
    const [runCancel, firstPendCancel] = cancelBtns;
    expect(runCancel.disabled).toBe(true);            // running can't be cancelled
    expect(firstPendCancel.disabled).toBe(false);     // pending CAN

    await act(async () => { fireEvent.click(firstPendCancel); await Promise.resolve(); });
    expect(cancelQueuedTask).toHaveBeenCalledWith('pend-1');
  });

  it('cancel button is disabled for running rows (no in-flight cancellation)', async () => {
    await renderAndExpand({});
    const cancelBtns = screen.getAllByLabelText('작업 취소');
    expect(cancelBtns[0].disabled).toBe(true);
    expect(cancelBtns[0].getAttribute('title')).toMatch(/실행 중/);
  });
});
