/**
 * logBoundaryFailure — structured error sink for runtime-boundary
 * failures (zod parse errors, error-boundary onError, mutation/query
 * fatal paths).
 *
 * Lane G ships this to console.warn for now. The captured payload
 * shape matches what a future telemetry backend (Sentry / PostHog /
 * `/api/metrics`) would consume — see TODOS.md for the production
 * observability follow-up paired with the backend metrics endpoint.
 *
 * Token scrubbing: Authorization headers and inline JWT-shaped
 * strings sometimes ride in error.message / stack from inside
 * fetchJSON's body extraction. We strip them before logging so an
 * accidentally-leaked token can't surface in browser devtools.
 */

export type BoundaryKind = 'top-level' | 'step' | 'mutation' | 'parse';

export interface BoundaryFailureContext {
  /** Lane identifier from the plan (e.g. "B", "E"). Helps correlate
   * a failing path with the implementation slice that owns it. */
  lane?: string;
  step?: 1 | 2 | 3 | null;
  /** Last user-visible action — "submit-host", "upload-image",
   * "switch-mode", etc. */
  userAction?: string;
  taskId?: string | null;
  requestId?: string | null;
  /** Free-form extras. Numeric/string values only — keeps the JSON
   * cheap to ship to a future backend. */
  extra?: Record<string, string | number | boolean | null>;
}

export interface BoundaryFailureRecord {
  ts: string;
  boundary: BoundaryKind;
  error: { name: string; message: string; stack?: string };
  context: BoundaryFailureContext;
}

// Matches:
//   - Bearer <jwt>     → strip
//   - eyJ... (JWT)     → strip
//   - any 24+ char hex → strip
const TOKEN_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/g,
  /eyJ[A-Za-z0-9._\-]{20,}/g,
  /[a-f0-9]{32,}/g,
];

export function scrubAuthTokens(s: string): string {
  let out = s;
  for (const p of TOKEN_PATTERNS) {
    out = out.replace(p, '<scrubbed>');
  }
  return out;
}

function toErrShape(err: unknown): BoundaryFailureRecord['error'] {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: scrubAuthTokens(err.message),
      stack: err.stack ? scrubAuthTokens(err.stack) : undefined,
    };
  }
  return { name: 'UnknownError', message: scrubAuthTokens(String(err)) };
}

export function logBoundaryFailure(
  boundary: BoundaryKind,
  err: unknown,
  context: BoundaryFailureContext = {},
): BoundaryFailureRecord {
  const record: BoundaryFailureRecord = {
    ts: new Date().toISOString(),
    boundary,
    error: toErrShape(err),
    context,
  };
  if (typeof console !== 'undefined') {
    // structured payload — future telemetry pipeline consumes the same
    // shape; for now devtools shows a single rich object the user can
    // inspect.
    // eslint-disable-next-line no-console
    console.warn('[boundary-failure]', record);
  }
  return record;
}
