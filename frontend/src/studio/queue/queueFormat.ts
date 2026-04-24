/**
 * Queue-specific formatters.
 *
 * Narrower scope than shared/format.ts because the queue panel uses a
 * short time-of-day style (`HH:MM:SS`) rather than the full datetime.
 * Keeping them per-feature avoids growing shared/format into a
 * kitchen-sink module.
 */

export function statusLabel(status: string | null | undefined): string {
  const map: Record<string, string> = {
    pending: '대기 중',
    running: '실행 중',
    completed: '완료',
    error: '오류',
    cancelled: '취소됨',
  };
  if (!status) return '';
  return map[status] ?? status;
}

export function formatTime(isoStr: string | null | undefined): string {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
