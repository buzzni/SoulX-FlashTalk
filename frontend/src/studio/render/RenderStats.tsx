/**
 * RenderStats — 3-column stats card shown on completion.
 *
 * 걸린 시간 (elapsed) / 파일 용량 (real size via HEAD) / 파일 형식.
 * All three are read-only; the parent component passes in the
 * resolved values (elapsed frozen at completion, file size from
 * getVideoMeta, format hardcoded for now — MP4 is all we output).
 */

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
      <div className="p-3 bg-secondary rounded-md">
        <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground">걸린 시간</div>
        <div className="text-base font-semibold num mono">{formatElapsed(elapsedMs ?? 0)}</div>
        {createdAt && (
          <div className="text-xs text-tertiary mt-0.5">작업생성날짜 {formatDateTime(createdAt)}</div>
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
