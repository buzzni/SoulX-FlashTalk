/**
 * VideoFrame — 220×9:16 letterbox container shared by RenderPreview
 * (live job) and ResultVideoCard (frozen manifest).
 *
 * Just the chrome: fixed 220px width, 9:16 aspect, rounded corners,
 * dark letterbox background, hairline border. Children handle the
 * status-specific content (video / error icon / spinner).
 *
 * `text-white` is set here because every status-state child needs it:
 * the spinner uses currentColor, and error/loading text sits on the
 * dark letterbox.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface VideoFrameProps {
  children: ReactNode;
  className?: string;
}

export function VideoFrame({ children, className }: VideoFrameProps) {
  return (
    <div
      className={cn(
        'relative w-[220px] aspect-[9/16] rounded-xl overflow-hidden border border-border bg-[#0b0d12] self-start text-white',
        className,
      )}
    >
      {children}
    </div>
  );
}
