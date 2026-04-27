import * as React from 'react';
import { WizardModal } from './wizard-modal';
import { WizardButton as Button } from './wizard-button';

/**
 * ConfirmModal — uniform confirm UX across the app.
 *
 * Replaces every `window.confirm()` call. Native confirms break the
 * design system (OS-styled), block the JS thread, and can't carry
 * preview content (script summary, target resolution, etc.). This
 * sits on top of WizardModal (Radix Dialog) so we get focus trap,
 * scroll lock, and keyboard handling for free.
 *
 * Two-step flow at the call site:
 *   1. open=true to ask
 *   2. onConfirm runs the action; onCancel / outside-click closes.
 */
export interface ConfirmModalProps {
  open: boolean;
  title?: React.ReactNode;
  /** Body content. Plain string or arbitrary JSX (lists, code, etc.). */
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" tints the confirm button red. Use for destructive ops
   * (cancel queued task, delete history row). */
  variant?: 'default' | 'danger';
  /** Disable the confirm button (e.g. while the action is mid-flight). */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = '확인',
  cancelLabel = '취소',
  variant = 'default',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  return (
    <WizardModal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description}
    </WizardModal>
  );
}
