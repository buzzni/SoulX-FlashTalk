/**
 * Queue — status snapshot + cancel.
 *
 * Polling lifecycle lives in `queueStore` (Phase 2); these are the
 * low-level fetches the store calls on each tick.
 */

import { fetchJSON } from './http';
import type { QueueSnapshot } from '../types/app';

export interface CallOptions {
  signal?: AbortSignal;
}

export function fetchQueue({ signal }: CallOptions = {}): Promise<QueueSnapshot> {
  return fetchJSON<QueueSnapshot>('/api/queue', { label: '작업 목록 조회', signal });
}

export function cancelQueuedTask(taskId: string, { signal }: CallOptions = {}): Promise<{
  message: string;
  task_id: string;
}> {
  return fetchJSON(`/api/queue/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
    label: '작업 취소',
    signal,
  });
}
