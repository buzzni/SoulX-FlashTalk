/**
 * Pagination — page numbers + ellipsis + prev/next, with a compact
 * mobile variant. Reusable across surfaces; first consumer is /results
 * per docs/results-page-overhaul-plan.md decision #16.
 *
 *   Desktop:  ◀ 1 … 4 [5] 6 … 12 ▶
 *   Mobile:   ◀ 5 / 12 ▶
 *
 * Renders nothing when totalPages ≤ 1. Keyboard nav (←/→/Home/End) when
 * any page button has focus. Sibling boundary keeps current ± 1 visible;
 * edge boundaries always show first/last when not adjacent.
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PaginationProps {
  page: number;          // 1-indexed
  totalPages: number;
  onChange: (page: number) => void;
  className?: string;
}

const ELLIPSIS = '…' as const;

function buildPageItems(page: number, totalPages: number): (number | typeof ELLIPSIS)[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const items: (number | typeof ELLIPSIS)[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  if (start > 2) items.push(ELLIPSIS);
  for (let p = start; p <= end; p += 1) items.push(p);
  if (end < totalPages - 1) items.push(ELLIPSIS);
  items.push(totalPages);
  return items;
}

export function Pagination({ page, totalPages, onChange, className }: PaginationProps) {
  if (totalPages <= 1) return null;

  const clamped = Math.max(1, Math.min(totalPages, page));
  const goPrev = () => clamped > 1 && onChange(clamped - 1);
  const goNext = () => clamped < totalPages && onChange(clamped + 1);

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
    else if (e.key === 'Home') { e.preventDefault(); onChange(1); }
    else if (e.key === 'End') { e.preventDefault(); onChange(totalPages); }
  };

  const items = buildPageItems(clamped, totalPages);

  return (
    <nav
      role="navigation"
      aria-label="페이지 이동"
      onKeyDown={onKeyDown}
      className={cn('flex justify-center mt-8', className)}
    >
      {/* Mobile compact: ◀ N / M ▶ */}
      <div className="flex sm:hidden items-center gap-3 text-sm-tight tabular-nums">
        <NavBtn aria-label="이전 페이지" disabled={clamped <= 1} onClick={goPrev}>
          <ChevronLeft className="size-4" />
        </NavBtn>
        <span className="text-ink-2 font-medium">
          {clamped} / {totalPages}
        </span>
        <NavBtn aria-label="다음 페이지" disabled={clamped >= totalPages} onClick={goNext}>
          <ChevronRight className="size-4" />
        </NavBtn>
      </div>

      {/* Desktop: numeric pages with ellipsis */}
      <div className="hidden sm:flex items-center gap-1">
        <NavBtn aria-label="이전 페이지" disabled={clamped <= 1} onClick={goPrev}>
          <ChevronLeft className="size-4" />
        </NavBtn>
        {items.map((it, i) =>
          it === ELLIPSIS ? (
            <span
              key={`ellipsis-${i}`}
              aria-hidden
              className="px-2 text-muted-foreground select-none"
            >
              …
            </span>
          ) : (
            <PageBtn
              key={it}
              page={it}
              active={it === clamped}
              onClick={() => onChange(it)}
            />
          ),
        )}
        <NavBtn aria-label="다음 페이지" disabled={clamped >= totalPages} onClick={goNext}>
          <ChevronRight className="size-4" />
        </NavBtn>
      </div>
    </nav>
  );
}

interface NavBtnProps {
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  'aria-label': string;
}

function NavBtn({ disabled, onClick, children, ...props }: NavBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center justify-center rounded-md transition-colors',
        'min-w-9 h-9 px-2',
        'text-ink-2 hover:bg-card hover:text-foreground',
        'disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-2 disabled:cursor-not-allowed',
        'cursor-pointer',
      )}
      {...props}
    >
      {children}
    </button>
  );
}

interface PageBtnProps {
  page: number;
  active: boolean;
  onClick: () => void;
}

function PageBtn({ page, active, onClick }: PageBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-md transition-colors',
        'min-w-9 h-9 px-2 text-sm-tight tabular-nums font-medium cursor-pointer',
        active
          ? 'bg-foreground text-background'
          : 'text-ink-2 hover:bg-card hover:text-foreground',
      )}
    >
      {page}
    </button>
  );
}
