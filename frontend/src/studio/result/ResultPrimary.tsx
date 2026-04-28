/**
 * ResultPrimary — single primary action + kebab menu for the result page.
 *
 * Replaces the legacy 2×2 ResultActions grid (renamed via git mv —
 * eng-review 2C). Per plan §"Status → primary mapping":
 *   completed → 내 컴퓨터에 저장 (download)
 *   error     → 재시도 (first failure) | 수정해서 다시 만들기 (retried_from set)
 *   cancelled → 새로 만들기
 *   loading   → skeleton primary + dimmed kebab
 *   processing→ kebab-only (no commit-able primary while task is in-flight)
 *
 * Kebab contents (common to all status rows): 새로 만들기 + 수정해서 다시 만들기.
 * Completed adds 공유 링크 복사 (was a primary in the old grid; demoted to
 * preserve the slot for download — see plan §"Open Questions" for revisit.)
 *
 * Responsive (D1A): on ≤640px the primary takes the full row, kebab moves
 * to its own row. Both bump from h-9 (36px) to h-11 (44px) to satisfy
 * minimum touch-target sizing.
 *
 * a11y: kebab trigger carries aria-haspopup="menu" + aria-label;
 * Radix DropdownMenu provides focus trap + Escape close + return-focus.
 */
import Icon from '../Icon.jsx';
import { MoreHorizontal } from 'lucide-react';
import { WizardButton as Button } from '@/components/wizard-button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';

export type ResultPrimaryStatus =
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'loading'
  | 'processing';

export interface ResultPrimaryProps {
  status: ResultPrimaryStatus;
  taskId: string;
  /** Lineage from the result manifest. Non-null = depth ≥ 1 → swap the
   *  error-status primary from 재시도 to 수정해서 다시 만들기 (D3A). */
  retriedFrom: string | null | undefined;
  copied: boolean;
  onCopyShare: () => void;
  onEdit: () => void;
  onRetry: () => void;
  onNew: () => void;
}

/** Touch-target + responsive sizing applied uniformly to primary + kebab.
 *  ≤640px: full-width row, 44px tall. ≥md: auto width, 36px tall (matches
 *  WizardButton size="" default). */
const ROW_BUTTON_CLASSES = 'w-full md:w-auto h-11 md:h-9';

export function ResultPrimary({
  status,
  taskId,
  retriedFrom,
  copied,
  onCopyShare,
  onEdit,
  onRetry,
  onNew,
}: ResultPrimaryProps) {
  // Loading: skeleton-shimmer primary + dimmed kebab. Reuses the same
  // utility class as the rest of the app (no layout shift on resolve).
  if (status === 'loading') {
    return (
      <div
        data-testid="result-primary"
        data-status="loading"
        className="flex flex-col md:flex-row gap-2 mt-auto md:justify-end"
      >
        <div
          className={`skeleton-shimmer rounded-md bg-muted ${ROW_BUTTON_CLASSES} min-w-[160px]`}
          aria-hidden="true"
        />
        <button
          type="button"
          disabled
          data-testid="result-primary-kebab"
          aria-label="다른 작업 열기"
          aria-haspopup="menu"
          className={`${ROW_BUTTON_CLASSES} inline-flex items-center justify-center gap-1.5 px-3 rounded-md border border-border text-muted-foreground opacity-60`}
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
          <span className="md:hidden">다른 작업</span>
        </button>
      </div>
    );
  }

  // Processing: queue race window — task is dispatched but no manifest yet.
  // No commit-able primary action exists, so render only the kebab. User
  // can still escape via 새로 만들기 or hop to 수정해서 다시 만들기.
  if (status === 'processing') {
    return (
      <div
        data-testid="result-primary"
        data-status="processing"
        className="flex flex-col md:flex-row gap-2 mt-auto md:justify-end"
      >
        <KebabMenu
          showShare={false}
          copied={copied}
          onCopyShare={onCopyShare}
          onEdit={onEdit}
          onNew={onNew}
        />
      </div>
    );
  }

  // For completed/error/cancelled: render primary + kebab.
  const showShareInKebab = status === 'completed';

  return (
    <div
      data-testid="result-primary"
      data-status={status}
      className="flex flex-col md:flex-row gap-2 mt-auto md:justify-end"
    >
      <PrimaryButton
        status={status}
        taskId={taskId}
        retriedFrom={retriedFrom}
        onRetry={onRetry}
        onEdit={onEdit}
        onNew={onNew}
      />
      <KebabMenu
        showShare={showShareInKebab}
        copied={copied}
        onCopyShare={onCopyShare}
        onEdit={onEdit}
        onNew={onNew}
      />
    </div>
  );
}

// ── Primary button ────────────────────────────────────────────────────

interface PrimaryButtonProps {
  status: 'completed' | 'error' | 'cancelled';
  taskId: string;
  retriedFrom: string | null | undefined;
  onRetry: () => void;
  onEdit: () => void;
  onNew: () => void;
}

function PrimaryButton({
  status,
  taskId,
  retriedFrom,
  onRetry,
  onEdit,
  onNew,
}: PrimaryButtonProps) {
  if (status === 'completed') {
    // Native <a download> — browsers handle the actual filesystem dialog.
    // Styled to match WizardButton variant=primary so it sits in the
    // same visual hierarchy.
    return (
      <a
        data-testid="result-primary-action"
        href={`/api/videos/${taskId}?download=true`}
        download
        className={`${ROW_BUTTON_CLASSES} inline-flex items-center justify-center gap-2 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors no-underline`}
      >
        <Icon name="download" size={14} />
        내 컴퓨터에 저장
      </a>
    );
  }

  if (status === 'error') {
    // D3A retry-aware swap: depth=0 (retried_from=null) → 재시도; depth≥1
    // → 수정해서 다시 만들기. Same input failing twice signals user-fixable
    // input; don't loop them through the queue again.
    const hasBeenRetried = retriedFrom != null && retriedFrom !== '';
    if (hasBeenRetried) {
      return (
        <Button
          data-testid="result-primary-action"
          icon="settings"
          variant="primary"
          onClick={onEdit}
          title="이전 시도가 같은 입력으로 실패했어요. 입력을 손봐서 다시 만들어요."
          className={ROW_BUTTON_CLASSES}
        >
          수정해서 다시 만들기
        </Button>
      );
    }
    return (
      <Button
        data-testid="result-primary-action"
        icon="refresh"
        variant="primary"
        onClick={onRetry}
        title="같은 입력으로 그대로 다시 시도"
        className={ROW_BUTTON_CLASSES}
      >
        재시도
      </Button>
    );
  }

  // cancelled — user changed their mind; restart fresh.
  return (
    <Button
      data-testid="result-primary-action"
      icon="plus"
      variant="primary"
      onClick={onNew}
      className={ROW_BUTTON_CLASSES}
    >
      새로 만들기
    </Button>
  );
}

// ── Kebab menu ────────────────────────────────────────────────────────

interface KebabMenuProps {
  showShare: boolean;
  copied: boolean;
  onCopyShare: () => void;
  onEdit: () => void;
  onNew: () => void;
}

function KebabMenu({
  showShare,
  copied,
  onCopyShare,
  onEdit,
  onNew,
}: KebabMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="result-primary-kebab"
          aria-label="다른 작업 열기"
          aria-haspopup="menu"
          className={`${ROW_BUTTON_CLASSES} inline-flex items-center justify-center gap-1.5 px-3 rounded-md border border-border bg-transparent hover:bg-secondary transition-colors text-foreground cursor-pointer`}
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
          <span className="md:hidden">다른 작업</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        {showShare && (
          <DropdownMenuItem onSelect={onCopyShare}>
            <Icon name={copied ? 'check' : 'link'} size={14} />
            {copied ? '링크 복사됨' : '공유 링크 복사'}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onEdit}>
          <Icon name="settings" size={14} />
          수정해서 다시 만들기
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNew}>
          <Icon name="plus" size={14} />
          새로 만들기
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
