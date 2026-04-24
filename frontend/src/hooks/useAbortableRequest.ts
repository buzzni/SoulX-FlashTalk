/**
 * useAbortableRequest — encapsulates the concurrency contract every
 * async hook in this codebase has to enforce:
 *
 *   1. AbortController — the in-flight fetch / SSE is aborted when
 *      the hook unmounts or the caller explicitly starts a new op.
 *
 *   2. Request epoch — a monotonic counter (ref'd so it survives
 *      renders without triggering them). Every `run` bumps the
 *      epoch. Results that come back with an older epoch are
 *      dropped before they hit state. This covers the races
 *      `AbortController` alone doesn't:
 *        - React 18 StrictMode double-mount
 *        - "Old upload arrives AFTER the user made a newer choice"
 *          (upload finishes late, overwrites fresher state)
 *        - "Server responds to request N-1 after N is already in
 *          flight" (backend took longer than expected; retry kicked
 *          off; old response arrives first)
 *
 * Contract for callers:
 *   const { run, isCurrent, signal, abort } = useAbortableRequest();
 *
 *   const doWork = async () => {
 *     const { signal, isCurrent } = run();
 *     try {
 *       const result = await api.something({ signal });
 *       if (!isCurrent()) return;             // stale epoch
 *       setState({ result });
 *     } catch (err) {
 *       if (!isCurrent()) return;             // stale
 *       if ((err as {name?: string})?.name === 'AbortError') return;
 *       setState({ error: err });
 *     }
 *   };
 *
 * `run()` returns a fresh snapshot of (signal, isCurrent) captured
 * at the moment you called it — both close over the epoch that was
 * current at run-time, so even callbacks fired much later can
 * correctly ask "am I still the freshest?".
 *
 * `abort()` cancels whatever is currently in flight without kicking
 * off a new op. Useful for "cancel" UX buttons.
 */

import { useCallback, useEffect, useRef } from 'react';

export interface AbortableRun {
  /** AbortSignal tied to this specific run — pass to `fetch`, api calls, etc. */
  signal: AbortSignal;
  /** Returns true if this run is still the latest. Call before every
   * `setState` in async callbacks. */
  isCurrent: () => boolean;
}

export interface UseAbortableRequestReturn {
  /** Start a new operation. Aborts any in-flight run, bumps the
   * epoch, returns a fresh `{signal, isCurrent}` snapshot. */
  run: () => AbortableRun;
  /** Abort whatever is in flight WITHOUT starting a new op. Use for
   * cancel-button UX. Safe to call when nothing is in flight. */
  abort: () => void;
  /** Cheap check for "is anything in flight right now" — a render-
   * cycle view into the epoch. Mostly useful in tests. */
  isActive: () => boolean;
}

export function useAbortableRequest(): UseAbortableRequestReturn {
  const epochRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  // Cleanup on unmount — aborts whatever the final run was.
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  const run = useCallback((): AbortableRun => {
    // Abort any predecessor. If nothing is in flight this is a no-op.
    controllerRef.current?.abort();

    const epoch = ++epochRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;

    return {
      signal: controller.signal,
      isCurrent: () => epoch === epochRef.current,
    };
  }, []);

  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    // Bump the epoch too, so any late-arriving result is rejected
    // even though no new run() was called.
    epochRef.current += 1;
  }, []);

  const isActive = useCallback(() => controllerRef.current !== null, []);

  return { run, abort, isActive };
}
