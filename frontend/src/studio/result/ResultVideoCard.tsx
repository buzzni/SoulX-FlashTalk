/**
 * ResultVideoCard — 220×9:16 playback column on the result page.
 *
 * Three visual variants: completed (native <video>), error (icon +
 * backend error string), processing (spinner — should be rare on a
 * dedicated result route, but covers the "navigated before manifest
 * ready" tick).
 */
import Icon from '../Icon.jsx';
import { Spinner } from '@/components/spinner';

export interface ResultVideoCardProps {
  status: 'completed' | 'error' | 'processing';
  videoUrl: string;
  errorMessage?: string | null;
}

export function ResultVideoCard({ status, videoUrl, errorMessage }: ResultVideoCardProps) {
  return (
    <div className="relative w-[220px] aspect-[9/16] rounded-xl overflow-hidden border border-border bg-[#0b0d12] self-start">
      {status === 'completed' && (
        // No autoPlay — user clicks to play. preload="metadata" so the
        // player knows duration/dimensions without fetching bytes.
        <video
          src={videoUrl}
          controls
          preload="metadata"
          className="w-full h-full object-cover"
        />
      )}
      {status === 'error' && (
        <div className="absolute inset-0 grid place-items-center text-white text-center p-4">
          <div>
            <Icon name="alert_circle" size={24} />
            <div className="text-xs mt-2 opacity-90">
              {errorMessage || '작업이 실패했어요'}
            </div>
          </div>
        </div>
      )}
      {status === 'processing' && (
        // text-white = sits on the dark video letterbox; tints the
        // spinner via currentColor.
        <div className="absolute inset-0 grid place-items-center text-white">
          <Spinner size="lg" />
        </div>
      )}
    </div>
  );
}
