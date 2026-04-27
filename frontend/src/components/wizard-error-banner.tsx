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

export interface WizardErrorBannerProps {
  message: string;
  /** Optional follow-up sentence (e.g. recovery instruction). */
  hint?: string;
  className?: string;
}

export function WizardErrorBanner({ message, hint, className }: WizardErrorBannerProps) {
  return (
    <div
      className={className}
      style={{
        padding: '10px 12px',
        background: 'var(--danger-soft)',
        border: '1px solid var(--danger)',
        borderRadius: 'var(--r-sm)',
        color: 'var(--danger)',
        fontSize: 12,
      }}
    >
      <Icon name="alert_circle" size={13} style={{ marginRight: 6 }} />
      {message}
      {hint && <> · {hint}</>}
    </div>
  );
}
