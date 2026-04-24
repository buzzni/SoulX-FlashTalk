/**
 * HTTP core — every api/* module imports from here.
 *
 * Responsibilities:
 *  - `fetchJSON<T>(url, init?)` — parsed JSON on 2xx, typed `ApiError` on
 *    anything else. `init.signal` is the universal cancellation channel;
 *    every caller threads an `AbortSignal` through it.
 *  - `humanizeError(err)` — UI-friendly Korean copy for common failures.
 *  - Auth-header provider (E2 slot) — noop today, returns `{}`. When auth
 *    lands, `authStore` swaps in a real provider via `setAuthProvider`
 *    and every existing call automatically gains the `Authorization`
 *    header. No per-module plumbing required.
 */

export const API_BASE: string = (import.meta as any).env?.VITE_API_BASE_URL ?? '';

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
 *  - Rethrows `AbortError` as-is so callers can distinguish user-cancelled
 *    operations from real failures.
 */
export async function fetchJSON<T = unknown>(
  path: string,
  { label = 'API 요청', signal, headers, ...init }: FetchJSONOptions = {},
): Promise<T> {
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
  return parseResponse<T>(res, label);
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
  if (e.status === 401) return '서비스 연결이 잘못됐어요. 관리자에게 문의해주세요.';
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
