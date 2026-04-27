import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  Card as ShadCard,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardAction,
} from '@/components/ui/card';

/**
 * WizardCard — terse helper that maps the legacy `<Card title subtitle
 * eyebrow action>...</Card>` API onto shadcn's CardHeader/Title/Description
 * composition. Keeps wizard step files readable. The visual chrome (border,
 * radius, padding, shadow) all come from shadcn Card; we just shrink the
 * default 6 padding/gap to match the wizard's compact density.
 */
export interface WizardCardProps {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  eyebrow?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export function WizardCard({
  title,
  subtitle,
  eyebrow,
  action,
  className,
  style,
  children,
}: WizardCardProps) {
  return (
    <ShadCard
      style={style}
      className={cn('gap-3.5 py-5 px-5 shadow-xs', className)}
    >
      {(title || subtitle || eyebrow || action) && (
        <CardHeader className="px-0 gap-1">
          <div>
            {eyebrow && (
              <div className="text-2xs uppercase tracking-widest font-semibold text-muted-foreground">
                {eyebrow}
              </div>
            )}
            {title && (
              <CardTitle className="text-sm tracking-tight">
                {title}
              </CardTitle>
            )}
            {subtitle && (
              <CardDescription className="text-xs">
                {subtitle}
              </CardDescription>
            )}
          </div>
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
      )}
      <CardContent className="px-0 flex flex-col gap-3.5">
        {children}
      </CardContent>
    </ShadCard>
  );
}
