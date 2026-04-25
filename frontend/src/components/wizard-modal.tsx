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
      <DialogContent className="sm:max-w-lg">
        {title && (
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
        )}
        <div className="text-[13px] text-foreground leading-relaxed">{children}</div>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
