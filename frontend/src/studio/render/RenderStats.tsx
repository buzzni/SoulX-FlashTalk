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
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
      <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
        <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground">걸린 시간</div>
        <div style={{ fontSize: 16, fontWeight: 600 }} className="num mono">
          {formatElapsed(elapsedMs ?? 0)}
        </div>
        {createdAt && (
          <div className="text-xs text-tertiary" style={{ marginTop: 2 }}>
            작업생성날짜 {formatDateTime(createdAt)}
          </div>
        )}
      </div>
      <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
        <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground">파일 용량</div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{formatFileSize(fileSizeBytes)}</div>
        {resolutionLabel && (
          <div className="text-xs text-tertiary" style={{ marginTop: 2 }}>
            {resolutionLabel}
          </div>
        )}
      </div>
      <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
        <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground">파일 형식</div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>MP4</div>
      </div>
    </div>
  );
}
