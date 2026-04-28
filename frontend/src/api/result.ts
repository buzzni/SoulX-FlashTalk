/**
 * Result manifest — read after a job completes.
 *
 * Replaces the inline `fetch('/api/results/${taskId}')` that ResultPage
 * used to do. Backend returns the persisted manifest or a synthesized
 * fallback (see `_synthesize_result_from_queue` in app.py).
 */

import { API_BASE, fetchJSON, getAuthHeaders, parseResponse } from './http';
import { schemas } from './schemas-generated';
import type { ResultManifest } from '../types/app';

export interface CallOptions {
  signal?: AbortSignal;
}

export function fetchResult(taskId: string, { signal }: CallOptions = {}): Promise<ResultManifest> {
  if (!taskId) {
    return Promise.reject(new Error('taskId가 비어 있어요'));
  }
  return fetchJSON(`/api/results/${encodeURIComponent(taskId)}`, {
    label: '결과 불러오기',
    signal,
    schema: schemas.ResultManifest,
  });
}

/**
 * Delete a result + cascade. Hits DELETE /api/videos/{task_id} which:
 *  - removes the video file (if any — none for failed/cancelled)
 *  - cascade-deletes committed step1/step2 images linked exclusively to it
 *  - drops the studio_results row
 */
export async function deleteResult(
  taskId: string,
  { signal }: CallOptions = {},
): Promise<{ message: string; task_id: string; row_deleted?: boolean }> {
  if (!taskId) throw new Error('taskId가 비어 있어요');
  const res = await fetch(`${API_BASE}/api/videos/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
    signal,
  });
  return parseResponse(res, '영상 삭제');
}
