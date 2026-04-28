/**
 * /api/jobs/* HTTP client.
 *
 * Step 15 of streaming-resume Phase B. Backend surface (Phase A):
 *   POST   /api/jobs                   create + dedupe
 *   GET    /api/jobs/:id               snapshot
 *   GET    /api/jobs                   cursor list
 *   GET    /api/jobs/:id/events        SSE (handled in jobSubscription.ts)
 *   DELETE /api/jobs/:id               cancel
 *
 * Functions return parsed JSON bodies; non-2xx responses raise ApiError
 * with the backend's `detail` propagated (matches the rest of frontend
 * api/* convention).
 */

import { API_BASE, ApiError, getAuthHeaders } from './http';
import type { JobKind, JobSnapshot } from '../stores/jobCacheStore';

// ────────────────────────────────────────────────────────────────────
// Request payloads. Mirror the Pydantic discriminated union on the
// backend (HostJobInput / CompositeJobInput).
// ────────────────────────────────────────────────────────────────────

export interface HostJobInput {
  mode: string;
  prompt?: string | null;
  extraPrompt?: string | null;
  negativePrompt?: string | null;
  builder?: Record<string, unknown> | null;
  faceRefPath?: string | null;
  outfitRefPath?: string | null;
  styleRefPath?: string | null;
  faceStrength?: number;
  outfitStrength?: number;
  outfitText?: string | null;
  seeds?: number[] | null;
  imageSize?: string;
  n?: number;
  temperature?: number | null;
}

export interface CompositeJobInput {
  hostImagePath: string;
  productImagePaths?: string[];
  backgroundType: 'preset' | 'upload' | 'prompt';
  backgroundPresetId?: string | null;
  backgroundPresetLabel?: string | null;
  backgroundUploadPath?: string | null;
  backgroundPrompt?: string | null;
  direction?: string;
  shot?: string;
  angle?: string;
  n?: number;
  rembg?: boolean;
  temperature?: number | null;
  seeds?: number[] | null;
  imageSize?: string;
}

export type CreateJobBody =
  | { kind: 'host'; input: HostJobInput }
  | { kind: 'composite'; input: CompositeJobInput };

// ────────────────────────────────────────────────────────────────────
// Functions
// ────────────────────────────────────────────────────────────────────

/** POST /api/jobs — returns the snapshot of the freshly-created (or
 * dedupe-hit) job. */
export async function createJob(body: CreateJobBody): Promise<JobSnapshot> {
  const res = await fetch(`${API_BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await apiError(res, 'job 생성 실패');
  }
  return (await res.json()) as JobSnapshot;
}

/** GET /api/jobs/:id — owner-scoped snapshot. 404 surfaces as ApiError. */
export async function getJob(jobId: string): Promise<JobSnapshot> {
  const res = await fetch(
    `${API_BASE}/api/jobs/${encodeURIComponent(jobId)}`,
    { headers: getAuthHeaders() },
  );
  if (!res.ok) {
    throw await apiError(res, 'job 조회 실패');
  }
  return (await res.json()) as JobSnapshot;
}

/** DELETE /api/jobs/:id — cancel an active job. 409 on already-terminal. */
export async function deleteJob(jobId: string): Promise<JobSnapshot> {
  const res = await fetch(
    `${API_BASE}/api/jobs/${encodeURIComponent(jobId)}`,
    { method: 'DELETE', headers: getAuthHeaders() },
  );
  if (!res.ok) {
    throw await apiError(res, 'job 취소 실패');
  }
  return (await res.json()) as JobSnapshot;
}

export interface ListJobsOptions {
  kind?: JobKind;
  state?: string;
  limit?: number;
  cursor?: string;
}

export interface JobListResponse {
  items: JobSnapshot[];
  next_cursor: string | null;
}

/** GET /api/jobs — cursor-paginated list. */
export async function listJobs(
  opts: ListJobsOptions = {},
): Promise<JobListResponse> {
  const params = new URLSearchParams();
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.state) params.set('state', opts.state);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', opts.cursor);
  const qs = params.toString();
  const url = `${API_BASE}/api/jobs${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { headers: getAuthHeaders() });
  if (!res.ok) {
    throw await apiError(res, 'job 목록 조회 실패');
  }
  return (await res.json()) as JobListResponse;
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

async function apiError(res: Response, fallback: string): Promise<ApiError> {
  let detail = '';
  try {
    detail = (await res.json())?.detail ?? '';
  } catch {
    /* non-JSON response — leave detail empty */
  }
  return new ApiError(`${fallback} (${res.status})`, {
    status: res.status,
    detail,
  });
}
