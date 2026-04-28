/**
 * Video history — GET /api/history (list) and GET /api/history/counts.
 *
 * Powers /results status filter + pagination per
 * docs/results-page-overhaul-plan.md decisions #14, #20.
 */

import { fetchJSON } from './http';
import { schemas } from './schemas-generated';
import type { HistoryResponse } from '../types/app';
import { z } from 'zod';

export interface CallOptions {
  signal?: AbortSignal;
}

// ── /api/history (list) ────────────────────────────────────────────

export type HistoryStatus = 'all' | 'completed' | 'error' | 'cancelled';

export interface HistoryQuery {
  status?: HistoryStatus;
  offset?: number;
  limit?: number;
  playlist_id?: string;       // hex id | "unassigned"
}

/**
 * Legacy entry point — single call with default page size.
 * Used by RenderHistory ("기다리는 동안" panel).
 *
 * Filters to `status=completed` so the wait-screen panel never surfaces
 * error/cancelled rows — those rows have no playable video file and
 * <video src="/api/videos/{id}"> would 404, breaking the inline preview.
 */
export function fetchHistory(limit = 10, { signal }: CallOptions = {}): Promise<HistoryResponse> {
  const clamped = Math.max(1, Math.min(100, limit | 0));
  return fetchJSON(`/api/history?status=completed&limit=${clamped}`, {
    label: '히스토리 조회',
    signal,
    schema: schemas.HistoryResponse,
  });
}

/**
 * Paginated query for /results. `status` defaults to "all" (decision #5).
 */
export function fetchHistoryPage(
  query: HistoryQuery = {},
  { signal }: CallOptions = {},
): Promise<HistoryResponse> {
  const params = new URLSearchParams();
  if (query.status && query.status !== 'all') params.set('status', query.status);
  if (typeof query.offset === 'number') params.set('offset', String(Math.max(0, query.offset)));
  if (typeof query.limit === 'number') params.set('limit', String(Math.max(1, Math.min(100, query.limit))));
  if (query.playlist_id) params.set('playlist_id', query.playlist_id);
  const qs = params.toString();
  return fetchJSON(`/api/history${qs ? `?${qs}` : ''}`, {
    label: '내 영상 목록',
    signal,
    schema: schemas.HistoryResponse,
  });
}

// ── /api/history/counts ────────────────────────────────────────────

export interface HistoryCounts {
  all: number;
  completed: number;
  error: number;
  cancelled: number;
}

const HistoryCountsSchema = z.object({
  all: z.number().int(),
  completed: z.number().int(),
  error: z.number().int(),
  cancelled: z.number().int(),
});

export function fetchHistoryCounts(
  playlist_id?: string,
  { signal }: CallOptions = {},
): Promise<HistoryCounts> {
  const qs = playlist_id ? `?playlist_id=${encodeURIComponent(playlist_id)}` : '';
  return fetchJSON(`/api/history/counts${qs}`, {
    label: '상태별 영상 개수',
    signal,
    schema: HistoryCountsSchema,
  });
}
