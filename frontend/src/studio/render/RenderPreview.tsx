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
    <div
      style={{
        width: 220,
        aspectRatio: '9/16',
        borderRadius: 12,
        overflow: 'hidden',
        background: '#0b0d12',
        position: 'relative',
        border: '1px solid var(--border)',
        alignSelf: 'start',
      }}
    >
      {status === 'done' && videoUrl ? (
        <video
          src={videoUrl}
          controls
          preload="metadata"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : status === 'error' ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
            textAlign: 'center',
            padding: 16,
          }}
        >
          <div>
            <Icon name="alert_circle" size={24} />
            <div style={{ fontSize: 12, marginTop: 8, opacity: 0.9 }}>{errorMessage}</div>
          </div>
        </div>
      ) : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
          }}
        >
          <div style={{ textAlign: 'center', padding: 12 }}>
            <div
              className="spinner"
              style={{
                width: 24,
                height: 24,
                margin: '0 auto 10px',
                borderColor: 'oklch(1 0 0 / 0.2)',
                borderTopColor: '#fff',
              }}
            />
            <div style={{ fontSize: 11, opacity: 0.85 }}>{stageLabel || '준비 중'}</div>
            {queuePosition != null && queuePosition > 0 && (
              <div style={{ fontSize: 10, opacity: 0.7, marginTop: 4 }}>
                앞에 {queuePosition}개 작업이 있어요
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
