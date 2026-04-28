import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

/**
 * WizardModal — `open + onClose + title + footer` API on top of shadcn
 * Dialog. Same call-site shape the wizard already had, but Radix handles
 * focus trap, scroll lock, portal, and outside-click dismissal.
 */
export interface WizardModalProps {
  open: boolean;
  onClose?: () => void;
  title?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function WizardModal({
  open,
  onClose,
  title,
  footer,
  children,
}: WizardModalProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose?.(); }}>
      {/* aria-describedby={undefined} — explicit opt-out of Radix's
          DialogDescription warning. WAI-ARIA requires aria-labelledby
          (DialogTitle covers it) but description is optional. Our modals
          render rich body content (paragraphs, line breaks) that doesn't
          map cleanly to a single description string, and forwarding via
          DialogDescription would nest <p> in <p>. Title alone meets the
          minimum a11y bar. */}
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        {title && (
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
        )}
        <div className="text-sm-tight text-foreground leading-relaxed">{children}</div>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
