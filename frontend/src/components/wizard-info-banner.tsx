/**
 * WizardInfoBanner — info/tip alert sibling to WizardErrorBanner.
 *
 * Two tones:
 *   - 'accent' (default): primary-tinted, used for instructive notes
 *     ("얼굴 사진이 필요해요…").
 *   - 'muted': neutral surface, used for softer tips that shouldn't
 *     compete with primary CTAs ("직접 녹음한 MP3·WAV 파일을…").
 *
 * Icon is fixed to `info` — this primitive is for info/tip semantics
 * only. For warn / success / error, use a different banner (or extend
 * with an `icon` prop if a real second use case appears).
 */

import type { ReactNode } from 'react';
import Icon from '../studio/Icon.jsx';
import { cn } from '@/lib/utils';

type Tone = 'accent' | 'muted';

// Use explicit `primary-*` tokens instead of `bg-accent` / `text-accent-
// foreground`. The `--accent` name historically resolved differently
// inside `.studio-root` than at global :root (see studio/styles/tokens.css
// header). This banner renders inside studio screens, so reaching for
// the explicit tokens makes the result robust against any future global
// `--accent` redefinition.
const TONE_CLASS: Record<Tone, string> = {
  accent: 'bg-primary-soft border border-primary text-primary-on-soft',
  muted: 'bg-secondary text-ink-2',
};

export interface WizardInfoBannerProps {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}

export function WizardInfoBanner({ children, tone = 'accent', className }: WizardInfoBannerProps) {
  return (
    <div className={cn('flex items-start gap-2 p-3 rounded-sm text-xs', TONE_CLASS[tone], className)}>
      <Icon name="info" size={14} />
      <div>{children}</div>
    </div>
  );
}
