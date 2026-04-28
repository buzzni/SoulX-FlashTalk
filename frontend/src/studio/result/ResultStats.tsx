/**
 * ResultStats — 3-row stacked stats on the result page.
 *
 * Distinct from RenderStats because the data shapes differ: here
 * `elapsedSec` is read from the backend manifest (`generation_time_sec`),
 * and the "completed at" timestamp is always available (no live tick).
 */
import { StatTile } from '../shared/StatTile';
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
    <div className="flex flex-col gap-2">
      <StatTile
        label="걸린 시간"
        value={formatElapsedSec(elapsedSec)}
        sub={completedAt ? `완료 ${formatDateTime(completedAt)}` : undefined}
        mono
      />
      <StatTile
        label="파일 용량"
        value={formatFileSize(fileSizeBytes)}
        sub={resolutionLabel ?? undefined}
      />
      <StatTile label="파일 형식" value="MP4" />
    </div>
  );
}
