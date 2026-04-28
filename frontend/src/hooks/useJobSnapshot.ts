/**
 * useJobSnapshot — React hook that returns the cached snapshot for a
 * given jobId, auto-subscribing to its SSE stream while mounted.
 *
 * The wizard's v9 schema carries only `attached(jobId)`; UI components
 * that need the variants/state use this hook to resolve the handle.
 *
 * Subscription lifecycle:
 *   - mount with non-null jobId → subscribeToJob (refcount up)
 *   - jobId changes        → close old handle, subscribe new
 *   - unmount              → close handle (refcount down; last close
 *                              disconnects and clears cache entry)
 *
 * Reactivity: the cache entry comes from a zustand selector. A
 * cache-write triggers a re-render only when the selected slice
 * changes (zustand uses Object.is on the selector return).
 */

import { useEffect } from 'react';
import {
  type JobCacheEntry,
  selectJobEntry,
  useJobCacheStore,
} from '../stores/jobCacheStore';
import { subscribeToJob } from '../api/jobSubscription';

export function useJobSnapshot(jobId: string | null): JobCacheEntry {
  const entry = useJobCacheStore(selectJobEntry(jobId));

  useEffect(() => {
    if (!jobId) return;
    const handle = subscribeToJob(jobId);
    return () => handle.close();
  }, [jobId]);

  return entry;
}
