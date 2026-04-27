/**
 * WizardErrorBanner — inline alert for inline failures in the wizard
 * step pages. Used for hook-driven errors (TTS / clone / upload) that
 * surface in the AI Card / upload Card. Tighter than a toast and lives
 * inside the same Card the action was attempted in.
 *
 * Step 3 was the first step to render two distinct error banners
 * (AI-mode submit + upload-mode eager-upload) — extracting the
 * styling here keeps both sites in sync. Step 1's HostControls and
 * Step 2's CompositionControls have inline equivalents that should
 * adopt this component in a follow-up sweep.
 */

import Icon from '../studio/Icon.jsx';
import { cn } from '@/lib/utils';

export interface WizardErrorBannerProps {
  message: string;
  /** Optional follow-up sentence (e.g. recovery instruction). */
  hint?: string;
  className?: string;
}

export function WizardErrorBanner({ message, hint, className }: WizardErrorBannerProps) {
  return (
    <div
      className={cn(
        'px-3 py-2.5 bg-destructive-soft border border-destructive text-destructive rounded-sm text-xs',
        className,
      )}
    >
      <Icon name="alert_circle" size={13} className="mr-1.5" />
      {message}
      {hint && <> · {hint}</>}
    </div>
  );
}
