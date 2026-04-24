/**
 * ResultVideoCard — 220×9:16 playback column on the result page.
 *
 * Three visual variants: completed (native <video>), error (icon +
 * backend error string), processing (spinner — should be rare on a
 * dedicated result route, but covers the "navigated before manifest
 * ready" tick).
 */
import Icon from '../Icon.jsx';

export interface ResultVideoCardProps {
  status: 'completed' | 'error' | 'processing';
  videoUrl: string;
  errorMessage?: string | null;
}

export function ResultVideoCard({ status, videoUrl, errorMessage }: ResultVideoCardProps) {
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
      {status === 'completed' && (
        // No autoPlay — user clicks to play. preload="metadata" so the
        // player knows duration/dimensions without fetching bytes.
        <video
          src={videoUrl}
          controls
          preload="metadata"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      )}
      {status === 'error' && (
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
            <div style={{ fontSize: 12, marginTop: 8, opacity: 0.9 }}>
              {errorMessage || '작업이 실패했어요'}
            </div>
          </div>
        </div>
      )}
      {status === 'processing' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
          }}
        >
          <span
            className="spinner"
            style={{
              width: 24,
              height: 24,
              borderColor: 'oklch(1 0 0 / 0.2)',
              borderTopColor: '#fff',
            }}
          />
        </div>
      )}
    </div>
  );
}
