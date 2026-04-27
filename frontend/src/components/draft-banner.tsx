/**
 * DraftBanner — surfaces an in-progress wizard draft on the home page.
 *
 * Renders a slim, full-width strip above the home hero cards when the
 * persisted wizard state has been touched. Returns null when no draft
 * exists, so callers can mount unconditionally.
 *
 *  ┌──────────────────────────────────────────────────────────┐
 *  │ ↻  진행 중인 작업 · 23분 전          [이어 만들기] [삭제]  │
 *  └──────────────────────────────────────────────────────────┘
 *
 * Discard uses an inline two-step confirm pattern (no modal): first
 * click flips the trailing region into "정말 삭제할까요? [취소] [삭제]".
 * Second click on 삭제 commits the reset. Confirm state auto-clears
 * after a short timeout so an abandoned confirmation doesn't sit there
 * forever.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Trash2 } from 'lucide-react';
import { useLastSavedAt } from '../stores/wizardStore';
import {
  discardDraft,
  formatDraftAge,
  resumeVideo,
  useDraftAgeTick,
} from '../lib/wizardNav';

const CONFIRM_TIMEOUT_MS = 4000;

export function DraftBanner() {
  const navigate = useNavigate();
  const lastSavedAt = useLastSavedAt();
  const [confirming, setConfirming] = useState(false);
  useDraftAgeTick(lastSavedAt != null);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [confirming]);

  if (lastSavedAt == null) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-3 px-4 py-3 mb-4 rounded-lg bg-card border border-border shadow-[var(--shadow-soft)]"
    >
      <span
        aria-hidden
        className="grid place-items-center size-8 rounded-md bg-primary-soft text-primary-on-soft shrink-0"
      >
        <Play className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-foreground tracking-[-0.012em]">
          진행 중인 작업이 있어요
        </div>
        <div className="text-[12px] text-muted-foreground tracking-[-0.005em]">
          {formatDraftAge(lastSavedAt)}
        </div>
      </div>
      {confirming ? (
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[12.5px] text-ink-2">정말 삭제할까요?</span>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="h-8 px-3 rounded-md text-[12.5px] font-semibold text-ink-2 hover:bg-surface-2 transition-colors cursor-pointer"
          >
            취소
          </button>
          <button
            type="button"
            onClick={() => {
              discardDraft();
              setConfirming(false);
            }}
            className="h-8 px-3 rounded-md text-[12.5px] font-semibold bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity cursor-pointer"
          >
            삭제
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => resumeVideo(navigate)}
            className="h-8 px-3.5 rounded-md text-[12.5px] font-semibold bg-primary text-primary-foreground hover:bg-[var(--primary-hover)] transition-colors cursor-pointer"
          >
            이어 만들기
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            aria-label="진행 중 작업 삭제"
            className="grid place-items-center size-8 rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground transition-colors cursor-pointer"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
