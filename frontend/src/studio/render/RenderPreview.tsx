/**
 * RenderPreview — 220×9:16 video-frame column.
 *
 * Three render states tied to the job's phase:
 *   - done      → <video> with controls
 *   - error     → red fail card with the error message
 *   - in-flight → spinner + current stage label + optional queue
 *                 position ("앞에 N개 작업이 있어요")
 *
 * Fixed width 220px with aspect-ratio: 9/16 so the frame never
 * reflows when the parent grid adjusts height.
 */

import Icon from '../Icon.jsx';
import { Spinner } from '@/components/spinner';

export interface RenderPreviewProps {
  status: 'pending' | 'rendering' | 'done' | 'error';
  videoUrl: string | null;
  errorMessage: string | null;
  stageLabel: string | null;
  queuePosition: number | null;
}

export function RenderPreview({
  status,
  videoUrl,
  errorMessage,
  stageLabel,
  queuePosition,
}: RenderPreviewProps) {
  return (
    <div className="relative w-[220px] aspect-[9/16] rounded-xl overflow-hidden border border-border bg-[#0b0d12] self-start">
      {status === 'done' && videoUrl ? (
        <video
          src={videoUrl}
          controls
          preload="metadata"
          className="w-full h-full object-cover"
        />
      ) : status === 'error' ? (
        <div className="absolute inset-0 grid place-items-center text-white text-center p-4">
          <div>
            <Icon name="alert_circle" size={24} />
            <div className="text-xs mt-2 opacity-90">{errorMessage}</div>
          </div>
        </div>
      ) : (
        // text-white = sits on the dark video letterbox; tints both the
        // spinner (currentColor) and the stage-label text below.
        <div className="absolute inset-0 grid place-items-center text-white">
          <div className="text-center p-3">
            <Spinner size="lg" className="mx-auto mb-2.5" />
            <div className="text-[11px] opacity-85">{stageLabel || '준비 중'}</div>
            {queuePosition != null && queuePosition > 0 && (
              <div className="text-[10px] opacity-70 mt-1">
                앞에 {queuePosition}개 작업이 있어요
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
