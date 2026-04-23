/**
 * QueueContext — single shared poller invariant.
 *
 * Regression: previously QueueStatus and RenderDashboard each ran their own
 * setInterval(fetchQueue, 4-5s) against the same endpoint. The dedupe
 * goal is "N consumers, 1 fetch per interval." This test fails the moment
 * someone re-introduces a per-consumer poller.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

vi.mock('../api.js', () => ({
  fetchQueue: vi.fn(),
}));

import { fetchQueue } from '../api.js';
import { QueueProvider, useQueue, useQueuePosition } from '../QueueContext.jsx';

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

beforeEach(() => {
  vi.useFakeTimers();
  fetchQueue.mockResolvedValue({
    running: [{ task_id: 'r1' }],
    pending: [{ task_id: 'p1' }, { task_id: 'p2' }],
    recent: [],
    total_running: 1,
    total_pending: 2,
  });
});

function ConsumerA() {
  const { data } = useQueue();
  return <div data-testid="a">{data ? `running=${data.running.length}` : 'loading'}</div>;
}

function ConsumerB() {
  const pos = useQueuePosition('p2');
  return <div data-testid="b">pos={pos == null ? 'null' : String(pos)}</div>;
}

function ConsumerC() {
  const { data } = useQueue();
  return <div data-testid="c">{data ? `pending=${data.pending.length}` : '...'}</div>;
}

describe('QueueContext', () => {
  it('runs ONE fetch per poll interval regardless of consumer count', async () => {
    render(
      <QueueProvider>
        <ConsumerA />
        <ConsumerB />
        <ConsumerC />
      </QueueProvider>
    );

    // Mount triggers immediate first fetch
    await act(async () => { await Promise.resolve(); });
    expect(fetchQueue).toHaveBeenCalledTimes(1);

    // Advance through several poll cycles — should fire once per cycle, not 3x
    await act(async () => { vi.advanceTimersByTime(4000); await Promise.resolve(); });
    expect(fetchQueue).toHaveBeenCalledTimes(2);

    await act(async () => { vi.advanceTimersByTime(4000); await Promise.resolve(); });
    expect(fetchQueue).toHaveBeenCalledTimes(3);

    await act(async () => { vi.advanceTimersByTime(4000); await Promise.resolve(); });
    expect(fetchQueue).toHaveBeenCalledTimes(4);
  });

  it('useQueuePosition returns 0 for running, N for pending (1-indexed), null for unknown', async () => {
    function PosProbe({ taskId, label }) {
      const pos = useQueuePosition(taskId);
      return <div data-testid={label}>{pos == null ? 'null' : String(pos)}</div>;
    }

    const { getByTestId } = render(
      <QueueProvider>
        <PosProbe taskId="r1" label="running" />
        <PosProbe taskId="p1" label="first-pending" />
        <PosProbe taskId="p2" label="second-pending" />
        <PosProbe taskId="ghost" label="not-in-queue" />
      </QueueProvider>
    );

    await act(async () => { await Promise.resolve(); });
    expect(getByTestId('running').textContent).toBe('0');
    expect(getByTestId('first-pending').textContent).toBe('1');
    expect(getByTestId('second-pending').textContent).toBe('2');
    expect(getByTestId('not-in-queue').textContent).toBe('null');
  });

  it('useQueue outside provider returns safe fallback (no crash)', () => {
    function Bare() {
      const { data, error } = useQueue();
      return <div data-testid="bare">{data == null && error == null ? 'safe' : 'unsafe'}</div>;
    }
    const { getByTestId } = render(<Bare />);
    expect(getByTestId('bare').textContent).toBe('safe');
  });
});
