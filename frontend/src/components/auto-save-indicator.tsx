/**
 * AutoSaveIndicator — surfaces the wizard's invisible auto-save.
 *
 * Reads `lastSavedAt` from the wizard store (stamped by every slice
 * setter). Renders a tiny "방금 전 저장됨" / "5초 전 저장됨" /
 * "1분 전 저장됨" badge that ticks every 10s so the relative time
 * stays current while the user reads.
 *
 * Renders nothing until the first slice write — a fresh wizard
 * shouldn't claim "saved" before the user has typed anything.
 */

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { useLastSavedAt } from '../stores/wizardStore';

function formatRelative(savedAtMs: number, nowMs: number): string {
  const deltaSec = Math.max(0, Math.floor((nowMs - savedAtMs) / 1000));
  if (deltaSec < 5) return '방금 전 저장됨';
  if (deltaSec < 60) return `${deltaSec}초 전 저장됨`;
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}분 전 저장됨`;
  const hr = Math.floor(min / 60);
  return `${hr}시간 전 저장됨`;
}

export function AutoSaveIndicator() {
  const lastSavedAt = useLastSavedAt();
  // Tick every 10s so relative time stays current. State holds `now`
  // rather than the formatted string so the same tick covers any
  // future consumer that wants its own formatter.
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (lastSavedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [lastSavedAt]);

  if (lastSavedAt === null) return null;

  return (
    <div
      className="inline-flex items-center gap-1 text-2xs text-muted-foreground"
      data-testid="auto-save-indicator"
      aria-live="polite"
    >
      <Check className="size-3" aria-hidden />
      <span>{formatRelative(lastSavedAt, now)}</span>
    </div>
  );
}
