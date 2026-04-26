/**
 * ErrorAlert — inline error block with a "다시 시도" affordance.
 *
 * Lane G drops this beside primary actions (host generate, composite
 * generate, voice generate, render dispatch, upload) so a mutation
 * failure shows a recovery surface in-place rather than a toast that
 * vanishes. Toasts still fire for ambient errors; ErrorAlert is for
 * the action the user just clicked.
 */

import { AlertCircle, RotateCcw } from 'lucide-react';
import { humanizeError } from '../api/http';

export interface ErrorAlertProps {
  error: unknown;
  onRetry?: () => void;
  /** Override the default Korean retry label. */
  retryLabel?: string;
  /** Hide the retry button — e.g. when the user has to re-upload a
   * file rather than re-fire the same mutation. */
  hideRetry?: boolean;
}

export function ErrorAlert({ error, onRetry, retryLabel = '다시 시도', hideRetry }: ErrorAlertProps) {
  const message = humanizeError(error);
  return (
    <div
      role="alert"
      className="flex items-start gap-2 px-3 py-2 rounded-md bg-error-soft text-error-on-soft text-[12.5px]"
      data-testid="error-alert"
    >
      <AlertCircle className="size-4 shrink-0 mt-0.5" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="font-medium">{message}</div>
      </div>
      {!hideRetry && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[12px] font-semibold border border-current/20 hover:bg-current/5 cursor-pointer"
        >
          <RotateCcw className="size-3" aria-hidden />
          {retryLabel}
        </button>
      )}
    </div>
  );
}
