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

const TONE_CLASS: Record<Tone, string> = {
  accent: 'bg-accent border border-accent text-accent-foreground',
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
