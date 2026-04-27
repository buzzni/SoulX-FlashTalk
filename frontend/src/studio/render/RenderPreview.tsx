/**
 * RenderPreview — 220×9:16 video-frame column.
 *
 * Three render states tied to the job's phase:
 *   - done      → <video> with controls
 *   - error     → red fail card with the error message
 *   - in-flight → spinner + current stage label + optional queue
 *                 position ("앞에 N개 작업이 있어요")
 */

import Icon from '../Icon.jsx';
import { Spinner } from '@/components/spinner';
import { VideoFrame } from '../shared/VideoFrame';

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
    <VideoFrame>
      {status === 'done' && videoUrl ? (
        <video
          src={videoUrl}
          controls
          preload="metadata"
          className="w-full h-full object-cover"
        />
      ) : status === 'error' ? (
        <div className="absolute inset-0 grid place-items-center text-center p-4">
          <div>
            <Icon name="alert_circle" size={24} />
            <div className="text-xs mt-2 opacity-90">{errorMessage}</div>
          </div>
        </div>
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <div className="text-center p-3">
            <Spinner size="lg" className="mx-auto mb-2.5" />
            <div className="text-2xs opacity-85">{stageLabel || '준비 중'}</div>
            {queuePosition != null && queuePosition > 0 && (
              <div className="text-2xs opacity-70 mt-1">
                앞에 {queuePosition}개 작업이 있어요
              </div>
            )}
          </div>
        </div>
      )}
    </VideoFrame>
  );
}
