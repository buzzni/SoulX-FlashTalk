/**
 * QueryClient — single global cache for the wizard pipeline.
 *
 * Defaults intentionally narrow:
 *   - queries: retry on transient 5xx via ApiError.status, exponential
 *     backoff capped at 8s, no retry on user-cancel or 4xx.
 *   - mutations: no auto-retry by default — generation POSTs are NOT
 *     idempotent and would create duplicate jobs. Idempotent mutations
 *     (uploads) opt in per call.
 *   - 30s staleTime + refetchOnWindowFocus off matches the wizard's
 *     manual-action UX; nothing should refetch behind the user's back.
 */

import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './http';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, err) =>
        failureCount < 3 && err instanceof ApiError && (err.status ?? 0) >= 500,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: 0 },
  },
});
