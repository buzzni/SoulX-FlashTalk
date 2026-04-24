/**
 * Sidecar type declarations for primitives.jsx.
 *
 * TypeScript can't infer that a JS destructured-default parameter
 * like `({ variant = 'secondary', icon, ... }) => JSX` has ALL
 * optional props — it reads each destructured name as "required
 * prop of this name." Without this file, every <Button /> in a .tsx
 * file screams "missing iconRight, style, …".
 *
 * The real primitives.jsx stays as-is (no runtime change). Phase 4
 * progresses toward renaming this to .tsx with real per-prop types,
 * at which point this sidecar can go away.
 */

import type { CSSProperties, ReactNode } from 'react';

type IconName = string;
type Optional<T> = T | undefined | null;

export interface ButtonProps {
  children?: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | string;
  size?: 'sm' | 'md' | 'lg' | string;
  icon?: IconName;
  iconRight?: IconName;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  className?: string;
  style?: CSSProperties;
  [key: string]: unknown;
}
export const Button: React.FC<ButtonProps>;

export interface SegmentedOption<V = unknown> {
  value: V;
  label: string;
  icon?: IconName;
}
export interface SegmentedProps<V = unknown> {
  options: SegmentedOption<V>[];
  value: V;
  onChange: (v: V) => void;
}
export const Segmented: <V = unknown>(props: SegmentedProps<V>) => JSX.Element;

export interface SliderProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  formatValue?: (v: number) => string;
  ariaLabel?: string;
}
export const Slider: React.FC<SliderProps>;

export interface UploadTileFile {
  name?: string;
  size?: number;
  type?: string;
  url?: string;
  _file?: File;
}
export interface UploadTileProps {
  file?: Optional<UploadTileFile>;
  onFile: (file: UploadTileFile | null) => void | Promise<void>;
  onRemove?: () => void;
  label?: string;
  sub?: string;
  accept?: string;
  compact?: boolean;
}
export const UploadTile: React.FC<UploadTileProps>;

export interface ChipProps {
  on?: boolean;
  onClick?: () => void;
  children?: ReactNode;
}
export const Chip: React.FC<ChipProps>;

export interface BadgeProps {
  variant?: 'neutral' | 'success' | 'warn' | 'danger' | 'accent' | string;
  children?: ReactNode;
  icon?: IconName;
}
export const Badge: React.FC<BadgeProps>;

export interface CardProps {
  title?: string;
  subtitle?: string;
  eyebrow?: string;
  action?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
}
export const Card: React.FC<CardProps>;

export interface FieldProps {
  label?: string;
  hint?: string;
  children?: ReactNode;
}
export const Field: React.FC<FieldProps>;

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children?: ReactNode;
  footer?: ReactNode;
}
export const Modal: React.FC<ModalProps>;
