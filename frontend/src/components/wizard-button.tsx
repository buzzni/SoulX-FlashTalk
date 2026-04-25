import * as React from 'react';
import { Button as ShadButton } from '@/components/ui/button';
import Icon from '@/studio/Icon.jsx';

/**
 * WizardButton — shadcn Button + the wizard's `variant in {primary, secondary,
 * ghost, danger}` + `icon="name"` string convention. Maps to shadcn's
 * default/outline/ghost/destructive variants. The Icon string lookup uses
 * the existing studio/Icon.jsx SVG path map so we don't have to migrate
 * every callsite to lucide individually.
 */

const VARIANT_MAP: Record<string, 'default' | 'outline' | 'ghost' | 'destructive'> = {
  primary: 'default',
  secondary: 'outline',
  ghost: 'ghost',
  danger: 'destructive',
};

const SIZE_MAP: Record<string, 'default' | 'sm' | 'lg'> = {
  '': 'default',
  sm: 'sm',
  lg: 'lg',
};

export interface WizardButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: '' | 'sm' | 'lg';
  icon?: string;
  iconRight?: string;
  children?: React.ReactNode;
}

export function WizardButton({
  variant = 'secondary',
  size = '',
  icon,
  iconRight,
  children,
  type = 'button',
  ...rest
}: WizardButtonProps) {
  return (
    <ShadButton
      type={type}
      variant={VARIANT_MAP[variant] ?? 'outline'}
      size={SIZE_MAP[size] ?? 'default'}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 13 : 14} />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 13 : 14} />}
    </ShadButton>
  );
}
