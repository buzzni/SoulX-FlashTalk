/**
 * Queue — status snapshot + cancel.
 *
 * Polling lifecycle lives in `queueStore` (Phase 2); these are the
 * low-level fetches the store calls on each tick.
 */

import { z } from 'zod';
import { fetchJSON } from './http';
import { schemas } from './schemas-generated';
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
