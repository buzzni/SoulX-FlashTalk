/**
 * Video history — list of past completed jobs.
 *
 * Read by `RenderHistory` ("기다리는 동안" panel) while the user waits
 * for the current job. Capped on the backend at the last 100 entries;
 * the `limit` query param is further clamped client-side.
 */

import { fetchJSON } from './http';
import { schemas } from './schemas-generated';
import type { HistoryResponse } from '../types/app';

export interface CallOptions {
  signal?: AbortSignal;
}

export function fetchHistory(limit = 10, { signal }: CallOptions = {}): Promise<HistoryResponse> {
  const clamped = Math.max(1, Math.min(100, limit | 0));
  return fetchJSON(`/api/history?limit=${clamped}`, {
    label: '히스토리 조회',
    signal,
    schema: schemas.HistoryResponse,
  });
}
