// QueueContext — single shared poller for /api/queue.
// Replaces two independent setInterval pollers (QueueStatus 5s + RenderDashboard
// 4s) that hit the same backend endpoint. One provider, one fetch every 4s,
// every consumer reads from the same snapshot.
//
// Hook API:
//   const { data, error, refresh } = useQueue();
//   - data:     last successful response { running, pending, recent, ... } or null
//   - error:    last fetch error message or null
//   - refresh:  manually trigger a fetch (e.g., right after enqueueing)
//
// Consumers can also call useQueuePosition(taskId) to get just the position
// for one task — derived directly from the shared snapshot.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { fetchQueue } from './api.js';

const POLL_MS = 4000;

const QueueContext = createContext(null);

export function QueueProvider({ children }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const d = await fetchQueue();
      if (!aliveRef.current) return;
      setData(d);
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err.message || '큐 조회 실패');
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(t);
    };
  }, [refresh]);

  return (
    <QueueContext.Provider value={{ data, error, refresh }}>
      {children}
    </QueueContext.Provider>
  );
}

export function useQueue() {
  const ctx = useContext(QueueContext);
  if (!ctx) {
    // Safe fallback so consumers don't crash if rendered outside the provider
    // during tests or storybook. Returns the shape with no data.
    return { data: null, error: null, refresh: () => {} };
  }
  return ctx;
}

// Returns the queue position for a given task_id from the latest snapshot:
//   - 0  → currently running
//   - N  → Nth in pending queue (1-indexed)
//   - null → not in queue (finished, never enqueued, or snapshot not loaded)
export function useQueuePosition(taskId) {
  const { data } = useQueue();
  if (!taskId || !data) return null;
  const runningIdx = (data.running || []).findIndex(t => t.task_id === taskId);
  if (runningIdx >= 0) return 0;
  const pendingIdx = (data.pending || []).findIndex(t => t.task_id === taskId);
  if (pendingIdx >= 0) return pendingIdx + 1;
  return null;
}

// Returns the full queue entry { task_id, type, label, status, created_at,
// started_at, completed_at, error, ... } for a given task_id, or null. Looks
// across running, pending, and recent so RenderDashboard can show consistent
// timestamps regardless of whether the task is still live or already done.
export function useQueueEntry(taskId) {
  const { data } = useQueue();
  if (!taskId || !data) return null;
  const lists = [data.running || [], data.pending || [], data.recent || []];
  for (const list of lists) {
    const found = list.find(t => t.task_id === taskId);
    if (found) return found;
  }
  return null;
}
