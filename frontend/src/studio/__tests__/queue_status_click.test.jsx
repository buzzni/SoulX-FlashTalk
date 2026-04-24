/**
 * QueueStatus — running/pending items navigate to /?attach=:taskId, completed
 * items navigate to /result/:taskId. Self-contained (no onTaskClick prop);
 * uses react-router's useNavigate directly.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// Mock the underlying domain module — `api.js` re-exports from here,
// so both `import from '../api.js'` and the queueStore's direct
// import from `../../api/queue` pick up the mock.
vi.mock('../../api/queue', () => ({
  fetchQueue: vi.fn(),
  cancelQueuedTask: vi.fn(),
}));

import { fetchQueue, cancelQueuedTask } from '../../api/queue';
import QueueStatus from '../QueueStatus.tsx';
import { __queueStoreInternals } from '../../stores/queueStore';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  __queueStoreInternals.reset();
});

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

// Route spy — renders "LANDED: {location}" so tests can read where QueueStatus
// navigated to. MemoryRouter's useLocation is read via a sibling <Route> that
// matches the wildcard and stringifies its location.
function LocationSpy() {
  // Exposes current MemoryRouter location to assertions. jsdom's
  // window.location doesn't sync with MemoryRouter, so we have to read
  // from the router context.
  const loc = useLocation();
  return <div data-testid="landed">LANDED:{loc.pathname}{loc.search}</div>;
}

async function renderAndExpand() {
  const result = render(
    <MemoryRouter initialEntries={["/"]}>
      <QueueStatus />
      <LocationSpy />
    </MemoryRouter>
  );
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByTitle('작업 목록 보기'));
  return result;
}

describe('QueueStatus click-to-navigate', () => {
  it('navigates to /?attach=:taskId when a running item is clicked', async () => {
    await renderAndExpand();
    fireEvent.click(screen.getByText('running script'));
    expect(screen.getByTestId('landed').textContent).toBe('LANDED:/?attach=run-1');
  });

  it('navigates to /?attach=:taskId when a pending item is clicked', async () => {
    await renderAndExpand();
    fireEvent.click(screen.getByText('first pending'));
    expect(screen.getByTestId('landed').textContent).toBe('LANDED:/?attach=pend-1');
  });

  it('pending rows expose an enabled cancel button that calls cancelQueuedTask', async () => {
    cancelQueuedTask.mockResolvedValue({ message: 'cancelled' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await renderAndExpand();
    // Running rows have no cancel button at all (backend can't kill in-flight
    // jobs, so the button was dead weight). Only the 2 pending rows show it.
    const cancelBtns = screen.getAllByLabelText('작업 취소');
    expect(cancelBtns).toHaveLength(2);
    expect(cancelBtns[0].disabled).toBe(false);

    await act(async () => { fireEvent.click(cancelBtns[0]); await Promise.resolve(); });
    expect(cancelQueuedTask).toHaveBeenCalledWith('pend-1');
  });

  it('running rows do not render a cancel button', async () => {
    await renderAndExpand();
    // One running row ('running script') exists but has no cancel control —
    // users should not see a disabled X that they can never use.
    expect(screen.getByText('running script')).toBeTruthy();
    const cancelBtns = screen.getAllByLabelText('작업 취소');
    // Only pending rows contribute cancel buttons.
    expect(cancelBtns).toHaveLength(2);
  });

  it('completed recent items navigate to /result/:taskId', async () => {
    fetchQueue.mockReset();
    fetchQueue.mockResolvedValue({
      running: [],
      pending: [],
      recent: [
        { task_id: 'done-1', type: 'generate', label: 'finished clip', status: 'completed', completed_at: '2026-04-23T11:00:00' },
      ],
      total_running: 0,
      total_pending: 0,
    });
    await renderAndExpand();

    const finishedRow = screen.getByText('finished clip').closest('button');
    expect(finishedRow).toBeTruthy();
    expect(finishedRow.getAttribute('title')).toMatch(/결과 영상/);
    fireEvent.click(finishedRow);
    expect(screen.getByTestId('landed').textContent).toBe('LANDED:/result/done-1');
  });

  it('errored recent items are NOT clickable (no result to show)', async () => {
    fetchQueue.mockReset();
    fetchQueue.mockResolvedValue({
      running: [],
      pending: [],
      recent: [
        { task_id: 'err-1', type: 'generate', label: 'failed clip', status: 'error', completed_at: '2026-04-23T11:01:00' },
      ],
      total_running: 0,
      total_pending: 0,
    });
    await renderAndExpand();

    const label = screen.getByText('failed clip');
    expect(label.closest('button')).toBeNull();
  });
});
