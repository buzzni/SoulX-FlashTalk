/**
 * RenderStats — 3-column stats card shown on completion.
 *
 * 걸린 시간 (elapsed) / 파일 용량 (real size via HEAD) / 파일 형식.
 * All three are read-only; the parent component passes in the
 * resolved values (elapsed frozen at completion, file size from
 * getVideoMeta, format hardcoded for now — MP4 is all we output).
 */

import { StatTile } from '../shared/StatTile';
import { formatDateTime, formatElapsed, formatFileSize } from './stages';

export interface RenderStatsProps {
  elapsedMs: number | null;
  createdAt?: string | null;
  fileSizeBytes: number | null;
  resolutionLabel: string | null;
}

export function RenderStats({
  elapsedMs,
  createdAt,
  fileSizeBytes,
  resolutionLabel,
}: RenderStatsProps) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <StatTile
        label="걸린 시간"
        value={formatElapsed(elapsedMs ?? 0)}
        sub={createdAt ? `작업생성날짜 ${formatDateTime(createdAt)}` : undefined}
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
