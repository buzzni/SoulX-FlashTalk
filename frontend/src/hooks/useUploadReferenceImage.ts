/**
 * useUploadReferenceImage — single-file upload helper that
 * enforces stale-result rejection.
 *
 * Pre-refactor, Step1 and Step2 had inline upload+set-path
 * choreography where a user could:
 *   1. Drop file A → upload kicks off
 *   2. Immediately drop file B → second upload kicks off
 *   3. Upload A finishes last → overwrites `path = /srv/a.png`,
 *      leaving the user looking at B's preview but with A's path.
 *
 * AbortController alone doesn't fix this if file A's upload was
 * already on the wire when B kicked off — the server finished the
 * request, the response came back, and the stale write wins.
 *
 * This hook wraps any upload function in the `useAbortableRequest`
 * epoch contract so only the most recent upload's result hits
 * state.
 *
 * Usage:
 *   const { upload, result, isLoading, error, abort } =
 *     useUploadReferenceImage(api.upload.uploadReferenceImage);
 *
 *   const onPick = async (file) => {
 *     const res = await upload(file);
 *     if (res) setPath(res.path);
 *   };
 */

import { useCallback, useState } from 'react';
import type { UploadOptions, UploadResult } from '../api/upload';
import { humanizeError } from '../api/http';
import { useAbortableRequest } from './useAbortableRequest';

export type UploadFn = (
  file: Blob,
  opts?: UploadOptions,
) => Promise<UploadResult>;

export interface UseUploadReferenceImageReturn {
  result: UploadResult | null;
  isLoading: boolean;
  error: string | null;
  /** Upload a file. Returns the result on success, or null if
   * aborted/stale/failed (check `error` for the failure case). */
  upload: (file: Blob) => Promise<UploadResult | null>;
  abort: () => void;
}

export function useUploadReferenceImage(uploadFn: UploadFn): UseUploadReferenceImageReturn {
  const [result, setResult] = useState<UploadResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { run, abort } = useAbortableRequest();

  const upload = useCallback(
    async (file: Blob): Promise<UploadResult | null> => {
      const { signal, isCurrent } = run();
      setIsLoading(true);
      setError(null);
      try {
        const res = await uploadFn(file, { signal });
        if (!isCurrent()) return null; // newer upload superseded us
        setResult(res);
        return res;
      } catch (err) {
        if (!isCurrent()) return null;
        const name = (err as { name?: string } | null)?.name;
        if (name === 'AbortError') return null;
        setError(humanizeError(err));
        return null;
      } finally {
        // Clear the spinner on ANY exit. When a newer upload
        // superseded us, its own `run()` already set isLoading=true
        // earlier in the tick — React batches, so the brief false
        // we set here is coalesced away. The important case is the
        // lone abort()/error, where nothing else will flip it back.
        setIsLoading(false);
      }
    },
    [run, uploadFn],
  );

  return { result, isLoading, error, upload, abort };
}
