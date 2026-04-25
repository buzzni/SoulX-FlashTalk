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
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
      <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
        <div className="text-[11px] uppercase tracking-widest font-semibold text-muted-foreground">걸린 시간</div>
        <div style={{ fontSize: 16, fontWeight: 600 }} className="num mono">
          {formatElapsedSec(elapsedSec)}
        </div>
        {completedAt && (
          <div className="text-xs text-tertiary" style={{ marginTop: 2 }}>
            완료 {formatDateTime(completedAt)}
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
