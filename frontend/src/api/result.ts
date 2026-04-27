/**
 * Result manifest — read after a job completes.
 *
 * Replaces the inline `fetch('/api/results/${taskId}')` that ResultPage
 * used to do. Backend returns the persisted manifest or a synthesized
 * fallback (see `_synthesize_result_from_queue` in app.py).
 */

import { fetchJSON } from './http';
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
