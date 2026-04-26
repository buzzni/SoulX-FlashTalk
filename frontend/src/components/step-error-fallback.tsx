/**
 * StepErrorFallback — per-step error boundary fallback.
 *
 * Per plan §3.5 the wizard has three error layers: top-level
 * (main.jsx → TopLevelErrorFallback), per-step (this), and
 * mutation/query inline (ErrorAlert). This fallback handles a
 * render-time crash inside a step page — keep it lighter-weight
 * than the top-level fallback because the user is mid-flow.
 *
 * `resetErrorBoundary` from react-error-boundary clears the boundary
 * state. `onReset` from the boundary's reset prop also fires —
 * step pages typically also reset the wizard slice that crashed.
 */

import type { FallbackProps } from 'react-error-boundary';
import { logBoundaryFailure } from '../lib/log-boundary-failure';
import { useEffect } from 'react';

export interface StepErrorFallbackProps extends FallbackProps {
  step: 1 | 2 | 3;
}

export function StepErrorFallback({ error, resetErrorBoundary, step }: StepErrorFallbackProps) {
  useEffect(() => {
    logBoundaryFailure('step', error, { step, userAction: 'render' });
  }, [error, step]);

  return (
    <div
      role="alert"
      className="mx-auto max-w-md mt-12 p-6 rounded-lg border border-rule-strong bg-card text-foreground"
    >
      <h2 className="text-base font-semibold">단계 {step}이(가) 잠깐 멈췄어요</h2>
      <p className="mt-2 text-[13px] text-muted-foreground">
        화면을 그리는 중 오류가 발생했습니다. 입력해둔 값은 그대로 유지되어 있어요.
        재시도하면 보통 복구됩니다.
      </p>
      <button
        type="button"
        onClick={resetErrorBoundary}
        className="mt-4 inline-flex items-center gap-2 h-9 px-3 rounded-md bg-primary text-primary-foreground text-[13px] font-semibold hover:bg-[var(--primary-hover)] cursor-pointer"
      >
        다시 시도
      </button>
    </div>
  );
}
