/**
 * Shared className constants for the queue panel rows.
 *
 * Note on min-w-0 sprinkled through these: CSS Grid's `1fr` track has
 * an implicit min-width:auto that expands to the longest descendant.
 * Long task labels (queue_label can hit 80 chars) would push each row
 * past the 340px panel width and produce horizontal scroll. min-w-0 +
 * overflow-hidden on grid items lets `truncate` (text-overflow:
 * ellipsis) actually clip.
 */

import { cn } from '@/lib/utils';

export const SECTION_CLASS = 'mt-2.5';

export const SECTION_HEADER_CLASS =
  'text-[11px] font-semibold text-ink-3 uppercase tracking-[0.04em] mb-1.5';

// Base layout shared by both row variants (live + recent). Row variants
// override or extend via cn() at the call site so tailwind-merge can
// dedupe conflicting utilities (template-string concat would silently
// produce both `mb-1` and `mb-0` etc.).
export const ROW_BASE_CLASS =
  'grid grid-cols-[minmax(0,1fr)_auto] gap-2 px-2.5 py-2 bg-secondary border border-border rounded-sm text-xs mb-1 min-w-0 overflow-hidden';

// Live row wrapper — sibling cancel button needs its own column.
export const LIVE_WRAPPER_WITH_CANCEL_CLASS =
  'grid grid-cols-[minmax(0,1fr)_auto] gap-1.5 items-stretch mb-1 min-w-0';
export const LIVE_WRAPPER_NO_CANCEL_CLASS = 'mb-1 min-w-0';

// Mini "as-button" override applied on top of ROW_BASE_CLASS via cn().
export const ROW_AS_BUTTON_CLASS =
  'w-full cursor-pointer text-inherit font-sans text-left mb-0';

// Pre-merged variant used by both LiveTaskRow + RecentTaskRow when the
// row body is rendered as a <button>. Computed once at module load so the
// tailwind-merge pass doesn't re-run on every queue poll re-render
// (panel can have 6-12 rows updating per tick).
export const ROW_BUTTON_CLASS = cn(ROW_BASE_CLASS, ROW_AS_BUTTON_CLASS);

// Cancel mini-button next to a live row.
export const CANCEL_BTN_BASE_CLASS =
  'w-7 bg-secondary border border-border rounded-sm grid place-items-center p-0';
