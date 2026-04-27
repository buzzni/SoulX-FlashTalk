/**
 * Queue — status snapshot + cancel.
 *
 * Polling lifecycle lives in `queueStore` (Phase 2); these are the
 * low-level fetches the store calls on each tick.
 */

import { z } from 'zod';
import { fetchJSON } from './http';
import { schemas } from './schemas-generated';
import { ApiError } from './http';
import type { QueueSnapshot } from '../types/app';

export interface CallOptions {
  signal?: AbortSignal;
}

export async function fetchQueue({ signal }: CallOptions = {}): Promise<QueueSnapshot> {
  // The generated zod schema treats fields as optional when the OpenAPI
  // spec doesn't list them in `required`, while openapi-typescript marks
  // them required. Cross the two with a single cast at the boundary —
  // the runtime parse already verified the body is shape-correct.
  const parsed = await fetchJSON('/api/queue', {
    label: '작업 목록 조회',
    signal,
    schema: schemas.QueueSnapshot,
  });
  return parsed as QueueSnapshot;
}

const CancelTaskResponseSchema = z
  .object({
    message: z.string(),
    task_id: z.string(),
  })
  .passthrough();

export function cancelQueuedTask(
  taskId: string,
  { signal }: CallOptions = {},
): Promise<z.infer<typeof CancelTaskResponseSchema>> {
  return fetchJSON(`/api/queue/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
    label: '작업 취소',
    signal,
    schema: CancelTaskResponseSchema,
  });
}

const RetryTaskResponseSchema = z
  .object({
    message: z.string(),
    task_id: z.string(),
  })
  .passthrough();

export function retryFailedTask(
  taskId: string,
  { signal }: CallOptions = {},
): Promise<z.infer<typeof RetryTaskResponseSchema>> {
  return fetchJSON(`/api/tasks/${encodeURIComponent(taskId)}/retry`, {
    method: 'POST',
    label: '작업 재시도',
    signal,
    schema: RetryTaskResponseSchema,
  });
}

const TaskStateLite = z
  .object({
    task_id: z.string(),
    stage: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

const TERMINAL_STAGES = new Set(['complete', 'completed', 'error', 'failed', 'cancelled', 'canceled']);

/** True iff the task is queued or in-flight at backend right now.
 * Returns false on 404 (task expired from task_states), on terminal
 * stages, and on network errors (caller decides whether to refire). */
export async function isTaskLive(
  taskId: string,
  { signal }: CallOptions = {},
): Promise<boolean> {
  try {
    const res = await fetchJSON(`/api/tasks/${encodeURIComponent(taskId)}/state`, {
      label: 'task state',
      signal,
      schema: TaskStateLite,
    });
    const stage = (res.stage ?? '').toLowerCase();
    return !TERMINAL_STAGES.has(stage);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false;
    throw err;
  }
}
