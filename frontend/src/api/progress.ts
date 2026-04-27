/**
 * Task progress — subscription to `/api/tasks/:task_id/state`.
 *
 * History: we used EventSource (SSE) at /api/progress/{task_id}, but
 * some client environments silently block EventSource (browser
 * extensions, corporate proxies, stuck HTTP/1.1 pools) while allowing
 * ordinary fetch. In those environments the render dashboard froze
 * forever at the initial 0%. Polling works everywhere.
 *
 * Contract: emits `onUpdate(snapshot)` whenever the (stage, progress,
 * message) signature changes. Stops on terminal stages. Gives up after
 * ~12s of consecutive fetch failures.
 *
 * AbortSignal support: the `unsubscribe()` return cancels the in-flight
 * poll AND stops scheduling the next tick. Callers use the return value
 * directly in `useEffect` cleanup — no external AbortController needed.
 */

import { fetchJSON } from './http';
import { schemas } from './schemas-generated';
import type { TaskStateSnapshot } from '../types/app';

const PROGRESS_POLL_MS = 1500;
const PROGRESS_MAX_CONSECUTIVE_ERRORS = 8; // ~12s of downtime before giving up

export type ProgressEvent =
  | { error: true }
  | {
      stage: TaskStateSnapshot['stage'];
      progress: TaskStateSnapshot['progress'];
      message: TaskStateSnapshot['message'];
      output_path?: TaskStateSnapshot['output_path'];
    };

export type ProgressHandler = (evt: ProgressEvent) => void;

export function subscribeProgress(taskId: string, onUpdate: ProgressHandler): () => void {
  const path = `/api/tasks/${encodeURIComponent(taskId)}/state`;
  const controller = new AbortController();
  let cancelled = false;
  let consecutiveErrors = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSignature: string | null = null;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const snapshot = (await fetchJSON(path, {
        label: '작업 상태 조회',
        signal: controller.signal,
        cache: 'no-store',
        schema: schemas.TaskStateSnapshot,
      })) as TaskStateSnapshot;
      consecutiveErrors = 0;

      const sig = `${snapshot.stage}|${snapshot.progress}|${snapshot.message}`;
      if (sig !== lastSignature) {
        lastSignature = sig;
        onUpdate({
          stage: snapshot.stage,
          progress: snapshot.progress,
          message: snapshot.message,
          output_path: snapshot.output_path,
        });
      }
      // Stop polling on terminal stages to avoid pointless traffic.
      if (snapshot.stage === 'complete' || snapshot.stage === 'error') {
        cancelled = true;
        return;
      }
    } catch (err) {
      // An AbortError here means the caller unsubscribed mid-poll — exit
      // quietly. All other errors count toward the failure budget. Check
      // by `name` for test-mock compatibility (see note in http.ts).
      if ((err as { name?: string })?.name === 'AbortError') {
        cancelled = true;
        return;
      }
      consecutiveErrors += 1;
      if (consecutiveErrors >= PROGRESS_MAX_CONSECUTIVE_ERRORS) {
        onUpdate({ error: true });
        cancelled = true;
        return;
      }
    }
    if (!cancelled) timer = setTimeout(tick, PROGRESS_POLL_MS);
  };

  // Fire immediately so the first render shows real state rather than
  // a 1.5-second placeholder.
  void tick();

  return () => {
    cancelled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      controller.abort();
    } catch {
      /* already aborted — ignore */
    }
  };
}
