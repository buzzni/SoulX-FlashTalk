/**
 * HTTP core — every api/* module imports from here.
 *
 * Responsibilities:
 *  - `fetchJSON(url, { schema, ... })` — parsed JSON on 2xx, then run
 *    through the supplied zod schema. Returns `z.infer<typeof schema>`.
 *    Schema is required at the call site (Lane B / D7) so backend renames
 *    surface as zod parse failures, not silent `undefined` propagation.
 *  - `humanizeError(err)` — UI-friendly Korean copy for common failures.
 *  - Auth-header provider (E2 slot) — noop today, returns `{}`. When auth
 *    lands, `authStore` swaps in a real provider via `setAuthProvider`
 *    and every existing call automatically gains the `Authorization`
 *    header. No per-module plumbing required.
 */

import type { z } from 'zod';

export const API_BASE: string = (import.meta as { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL ?? '';

/**
 * Streaming-resume Phase B step 23 — feature flag for the /api/jobs
 * cutover. Currently a marker: hooks (useHost/CompositeGeneration)
 * already use the new path unconditionally; the legacy SSE endpoints
 * stay live (deprecated headers + Sunset 2026-06-30) for any external
 * caller. Phase C step 25 deletes the legacy endpoints.
 *
 * Defaults true. Set VITE_USE_JOBS_API=false to opt out (the hooks
 * don't yet honor the false branch — that's a deliberate Phase C
 * decision: the cutover is forward-only).
 */
export const USE_JOBS_API: boolean = (() => {
  const raw = (import.meta as { env?: { VITE_USE_JOBS_API?: string } })
    .env?.VITE_USE_JOBS_API;
  if (raw === undefined) return true;
  return raw !== 'false' && raw !== '0';
})();

// ────────────────────────────────────────────────────────────────────
// E2 — Auth header provider (swapped in when the real authStore lands)
// ────────────────────────────────────────────────────────────────────

export type AuthHeaderProvider = () => Record<string, string>;

let authProvider: AuthHeaderProvider = () => ({});

export function setAuthProvider(provider: AuthHeaderProvider): void {
  authProvider = provider;
}

export function getAuthHeaders(): Record<string, string> {
  try {
    return authProvider() ?? {};
  } catch {
    return {};
  }
}

// 401/403 callback — authStore wires a redirect-to-login handler here.
// Default is a no-op so non-SPA contexts (tests, scripts) still work.
export type UnauthorizedHandler = (status: number) => void;
let onUnauthorized: UnauthorizedHandler = () => {};
export function setUnauthorizedHandler(fn: UnauthorizedHandler): void {
  onUnauthorized = fn;
}

// ────────────────────────────────────────────────────────────────────
// Typed errors
// ────────────────────────────────────────────────────────────────────

export interface ApiErrorOptions {
  status?: number;
  detail?: string;
  cause?: unknown;
}

export class ApiError extends Error {
  status?: number;
  detail?: string;
  constructor(message: string, opts: ApiErrorOptions = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.detail = opts.detail;
    if (opts.cause !== undefined) {
      // Attach as cause (supported in modern runtimes) for stack context.
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

// Duck-typed shape — legacy code attaches `status`/`detail` ad-hoc to
// plain Error instances; `humanizeError` treats both styles identically.
interface ErrorWithStatus {
  status?: number;
  detail?: string;
  message?: string;
  name?: string;
}

// ────────────────────────────────────────────────────────────────────
// Fetch wrapper
// ────────────────────────────────────────────────────────────────────

export interface FetchJSONOptions extends Omit<RequestInit, 'signal'> {
  /** Label used in thrown error messages (e.g. "호스트 생성"). */
  label?: string;
  signal?: AbortSignal;
}

/**
 * Thin wrapper around `fetch` that:
 *  - Merges auth headers from the provider (E2) with caller-supplied ones.
 *  - Parses JSON on 2xx; throws `ApiError` on non-2xx with best-effort
 *    body extraction.
 *  - Validates the parsed JSON against the supplied zod schema. Schema
 *    failure throws `ApiError` with status 0 — distinct from a network
 *    fault (network has no .status from the server) so callers can tell
 *    "backend returned a shape we don't understand" from "DNS broke".
 *  - Rethrows `AbortError` as-is so callers can distinguish user-cancelled
 *    operations from real failures.
 */
export async function fetchJSON<S extends z.ZodTypeAny>(
  path: string,
  { schema, label = 'API 요청', signal, headers, ...init }:
    FetchJSONOptions & { schema: S },
): Promise<z.infer<S>> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const merged: HeadersInit = { ...getAuthHeaders(), ...(headers as Record<string, string> | undefined) };
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: merged, signal });
  } catch (err) {
    // Abort surfaces here — let callers handle it (they typically just
    // return silently in useEffect cleanup). Anything else is a network
    // failure. Check by `name` rather than `instanceof DOMException` so
    // test-time mocks that throw a regular Error with `name: 'AbortError'`
    // still get recognised.
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new ApiError(`${label} 실패: ${msg}`, { cause: err });
  }
  const raw = await parseResponse<unknown>(res, label);
  return runSchema(schema, raw, label);
}

/** Apply a zod schema to a parsed-JSON payload, surfacing failures as
 * a structured ApiError with detail = the zod issues. */
export function runSchema<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
  label: string,
): z.infer<S> {
  // 204/205 surface here as `undefined`. Schemas that allow undefined
  // (e.g. `z.unknown()`, `z.void()`) accept it; others reject — which
  // is desirable, "no body" should not satisfy a "TaskResult" schema.
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
  throw new ApiError(`${label} 응답 형식 오류: ${detail}`, {
    status: 0,
    detail,
  });
}

/** Separated so streaming callers can reuse the body-extraction contract. */
export async function parseResponse<T>(res: Response, label: string): Promise<T> {
  if (res.ok) {
    // 204/205 → undefined; otherwise parse JSON. Intentionally permissive:
    // endpoints without content-type still parse if the body looks like
    // JSON, preserving pre-refactor behavior.
    if (res.status === 204 || res.status === 205) return undefined as T;
    return res.json() as Promise<T>;
  }
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.detail ?? JSON.stringify(body);
  } catch {
    try {
      detail = await res.text();
    } catch {
      /* body unreadable — swallow */
    }
  }
  // PR2: 401 (no/expired/revoked token) and 403 (subscription pulled)
  // both mean "kick to /login". Don't trigger on the login endpoint itself
  // — wrong-password 401 there is a normal user-facing failure.
  if ((res.status === 401 || res.status === 403)
      && !res.url.endsWith('/api/auth/login')) {
    try { onUnauthorized(res.status); } catch { /* ignore */ }
  }
  throw new ApiError(`${label} 실패 (${res.status}): ${detail}`, {
    status: res.status,
    detail,
  });
}

// ────────────────────────────────────────────────────────────────────
// Error → copy
// ────────────────────────────────────────────────────────────────────

export function humanizeError(err: unknown): string {
  if (!err) return '알 수 없는 오류가 발생했어요';
  const e = err as ErrorWithStatus;
  if (e.status === 429) return '지금은 많이 붐벼요. 잠시 후 다시 시도해주세요.';
  if (e.status === 401) return '로그인이 필요해요. 다시 로그인해주세요.';
  if (e.status === 403) return '접근 권한이 없어요. 관리자에게 문의해주세요.';
  if (e.status === 413) return '파일이 너무 커요 (최대 20MB).';
  if (e.status === 503) return '생성 결과가 부족해요. 다시 시도해주세요.';
  // TypeError typically means a network fault (CORS / DNS / no connection).
  // Some environments also set err.message to include "fetch" on network
  // errors — catch both to render friendly copy.
  if (e.name === 'TypeError' || (e.message && /fetch/i.test(e.message))) {
    return '네트워크 연결을 확인해주세요.';
  }
  return e.message || '오류가 발생했어요';
}

// ────────────────────────────────────────────────────────────────────
// Deprecation note — legacy callers may still pass a Response to
// `jsonOrThrow`. Provide a shim that mirrors the old behavior so the
// api.js re-export surface doesn't break.
// ────────────────────────────────────────────────────────────────────

/** @deprecated Use `fetchJSON` — this exists only for the api.js shim. */
export async function jsonOrThrow<T = unknown>(res: Response, label: string): Promise<T> {
  return parseResponse<T>(res, label);
}
