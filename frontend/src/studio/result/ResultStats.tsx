/**
 * ResultStats — 3-column stats card on the result page.
 *
 * Distinct from RenderStats because the data shapes differ: here
 * `elapsedSec` is read from the backend manifest (`generation_time_sec`),
 * and the "completed at" timestamp is always available (no live tick).
 */
import { formatElapsedSec, formatDateTime, formatFileSize } from '../shared/format';

export interface ResultStatsProps {
  elapsedSec: number | null | undefined;
  completedAt?: string | null;
  fileSizeBytes?: number | null;
  resolutionLabel?: string | null;
}

export function ResultStats({
  elapsedSec,
  completedAt,
  fileSizeBytes,
  resolutionLabel,
}: ResultStatsProps) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="p-3 bg-secondary rounded-md">
        <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground">걸린 시간</div>
        <div className="text-base font-semibold num mono">{formatElapsedSec(elapsedSec)}</div>
        {completedAt && (
          <div className="text-xs text-tertiary mt-0.5">완료 {formatDateTime(completedAt)}</div>
        )}
      </div>
      <div className="p-3 bg-secondary rounded-md">
        <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground">파일 용량</div>
        <div className="text-base font-semibold">{formatFileSize(fileSizeBytes)}</div>
        {resolutionLabel && (
          <div className="text-xs text-tertiary mt-0.5">{resolutionLabel}</div>
        )}
      </div>
      <div className="p-3 bg-secondary rounded-md">
        <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground">파일 형식</div>
        <div className="text-base font-semibold">MP4</div>
      </div>
    </div>
  );
}
