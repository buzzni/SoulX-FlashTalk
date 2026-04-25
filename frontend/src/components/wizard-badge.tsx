import * as React from 'react';
import { Badge as ShadBadge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import Icon from '@/studio/Icon.jsx';

/**
 * WizardBadge — shadcn Badge with the wizard's `variant in {neutral, accent,
 * success, warn}` convention. `success` and `warn` aren't in shadcn's
 * default variants, so we apply Tailwind overrides. `icon` accepts the
 * studio/Icon.jsx string name so existing callsites stay terse.
 */

const VARIANT_MAP: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  neutral: 'secondary',
  accent: 'default',
  success: 'outline',
  warn: 'outline',
};

const VARIANT_OVERRIDES: Record<string, string> = {
  success: 'border-[hsl(142_71%_45%/0.4)] bg-[hsl(142_71%_96%)] text-[hsl(142_71%_30%)]',
  warn: 'border-[hsl(38_92%_50%/0.4)] bg-[hsl(38_92%_96%)] text-[hsl(38_92%_35%)]',
};

export interface WizardBadgeProps {
  variant?: 'neutral' | 'accent' | 'success' | 'warn';
  icon?: string;
  className?: string;
  children: React.ReactNode;
}

export function WizardBadge({
  variant = 'neutral',
  icon,
  className,
  children,
}: WizardBadgeProps) {
  return (
    <ShadBadge
      variant={VARIANT_MAP[variant] ?? 'secondary'}
      className={cn(VARIANT_OVERRIDES[variant], 'gap-1', className)}
    >
      {icon && <Icon name={icon} size={11} />}
      {children}
    </ShadBadge>
  );
}
