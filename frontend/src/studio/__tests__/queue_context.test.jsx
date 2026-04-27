/**
 * queueStore — single shared poller invariant.
 *
 * Regression: previously QueueStatus and RenderDashboard each ran their own
 * setInterval(fetchQueue, 4-5s) against the same endpoint. The dedupe
 * goal is "N consumers, 1 fetch per interval." This test fails the moment
 * someone re-introduces a per-consumer poller.
 *
 * Phase 2a note: provider/context pattern replaced by a Zustand store
 * that reference-counts subscribers. No `<QueueProvider>` wrapper
 * needed — the hooks (`useQueue`, `useQueuePosition`, `useQueueEntry`)
 * auto-enroll on mount and release on unmount.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

vi.mock('../../api/queue', () => ({
  fetchQueue: vi.fn(),
  cancelQueuedTask: vi.fn(),
}));

import { fetchQueue } from '../../api/queue';
import { useQueue, useQueueEntry, useQueuePosition, __queueStoreInternals } from '../../stores/queueStore';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  // Reset refcount + state between tests — a leaked mount from one
  // test would otherwise bleed into the next.
  __queueStoreInternals.reset();
});

beforeEach(() => {
  vi.useFakeTimers();
  fetchQueue.mockResolvedValue({
    running: [{ task_id: 'r1', started_at: '2026-04-23T10:00:00', created_at: '2026-04-23T09:59:00' }],
    pending: [
      { task_id: 'p1', created_at: '2026-04-23T10:01:00' },
      { task_id: 'p2', created_at: '2026-04-23T10:02:00' },
    ],
    recent: [
      { task_id: 'rec1', created_at: '2026-04-23T09:00:00', started_at: '2026-04-23T09:01:00', completed_at: '2026-04-23T09:05:00', status: 'completed' },
    ],
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

describe('queueStore', () => {
  it('runs ONE fetch per poll interval regardless of consumer count', async () => {
    render(
      <>
        <ConsumerA />
        <ConsumerB />
        <ConsumerC />
      </>,
    );

    // Mount fires fetches at promotion boundaries: ConsumerA goes
    // idle→background (promotion → fetch), ConsumerB goes
    // background-only→active (promotion → fetch). ConsumerC mounts
    // into an already-active state, no promotion, no fetch.
    // Net mount-time fetches: 2.
    await act(async () => { await Promise.resolve(); });
    expect(fetchQueue.mock.calls.length).toBeLessThanOrEqual(2);
    const baseline = fetchQueue.mock.calls.length;

    // Then ONE fetch per active-tier interval (4s), regardless of
    // consumer count — that's the dedupe invariant.
    await act(async () => { vi.advanceTimersByTime(4000); await Promise.resolve(); });
    expect(fetchQueue).toHaveBeenCalledTimes(baseline + 1);

    await act(async () => { vi.advanceTimersByTime(4000); await Promise.resolve(); });
    expect(fetchQueue).toHaveBeenCalledTimes(baseline + 2);

    await act(async () => { vi.advanceTimersByTime(4000); await Promise.resolve(); });
    expect(fetchQueue).toHaveBeenCalledTimes(baseline + 3);
  });

  it('useQueuePosition returns 0 for running, N for pending (1-indexed), null for unknown', async () => {
    function PosProbe({ taskId, label }) {
      const pos = useQueuePosition(taskId);
      return <div data-testid={label}>{pos == null ? 'null' : String(pos)}</div>;
    }

    const { getByTestId } = render(
      <>
        <PosProbe taskId="r1" label="running" />
        <PosProbe taskId="p1" label="first-pending" />
        <PosProbe taskId="p2" label="second-pending" />
        <PosProbe taskId="ghost" label="not-in-queue" />
      </>,
    );

    await act(async () => { await Promise.resolve(); });
    expect(getByTestId('running').textContent).toBe('0');
    expect(getByTestId('first-pending').textContent).toBe('1');
    expect(getByTestId('second-pending').textContent).toBe('2');
    expect(getByTestId('not-in-queue').textContent).toBe('null');
  });

  it('useQueueEntry finds tasks across running/pending/recent and returns null otherwise', async () => {
    function EntryProbe({ taskId, label }) {
      const e = useQueueEntry(taskId);
      return <div data-testid={label}>{e == null ? 'null' : `${e.task_id}|${e.started_at || '-'}|${e.completed_at || '-'}`}</div>;
    }

    const { getByTestId } = render(
      <>
        <EntryProbe taskId="r1" label="running" />
        <EntryProbe taskId="p1" label="pending" />
        <EntryProbe taskId="rec1" label="recent" />
        <EntryProbe taskId="ghost" label="missing" />
      </>,
    );

    await act(async () => { await Promise.resolve(); });
    expect(getByTestId('running').textContent).toBe('r1|2026-04-23T10:00:00|-');
    expect(getByTestId('pending').textContent).toBe('p1|-|-');
    expect(getByTestId('recent').textContent).toBe('rec1|2026-04-23T09:01:00|2026-04-23T09:05:00');
    expect(getByTestId('missing').textContent).toBe('null');
  });

  it('polling stops when the last subscriber unmounts', async () => {
    const { unmount } = render(<ConsumerA />);
    await act(async () => { await Promise.resolve(); });
    expect(fetchQueue).toHaveBeenCalledTimes(1);

    unmount();
    // Reference count now 0 — advance past several poll intervals and
    // assert no further fetches.
    await act(async () => { vi.advanceTimersByTime(40_000); await Promise.resolve(); });
    expect(fetchQueue).toHaveBeenCalledTimes(1);
    expect(__queueStoreInternals.counts()).toEqual({ active: 0, background: 0 });
  });
});
