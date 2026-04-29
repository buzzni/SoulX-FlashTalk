/**
 * SavedHostCard — shared 3:4 portrait card for saved hosts.
 *
 * PR1 ships this component pre-emptively because PR2 (HostsLibraryPage)
 * and PR3 (Step1 [내 호스트] picker grid) both consume it. Defining it
 * once in PR1 avoids a merge conflict between the two later worktrees.
 *
 * Two surfaces:
 *  - showActions=false (PR3 step 1 picker)  → click-to-select only
 *  - showActions=true  (PR2 library page)   → hover ⋯ menu (rename/delete)
 *
 * Card aspect (3:4 portrait) matches the "이 사람 한 명" mental model —
 * the in-step-1 generated variant grid uses 9:16 because those are
 * "candidates being evaluated"; saved hosts are "people you've kept".
 * The shape difference is intentional (eng-review code-quality #4).
 *
 * Image fallback: when `host.url` 404s (e.g. stale storage_key after
 * cron retention sweep), the <img onError> swap renders a neutral
 * placeholder instead of a broken-image icon.
 */

import { useState } from 'react';
import { MoreHorizontal, Pencil, Trash2, UserCircle } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { SavedHost } from '../api/queries/use-saved-hosts';

export interface SavedHostCardProps {
  host: SavedHost;
  /** Selected ring (PR3 picker) — defaults false. */
  selected?: boolean;
  /** Show hover ⋯ menu with rename/delete (PR2 library) — defaults false. */
  showActions?: boolean;
  /** Click handler — fires on the whole card. */
  onClick?: (host: SavedHost) => void;
  /** Rename action — only used when showActions=true. */
  onRename?: (host: SavedHost) => void;
  /** Delete action — only used when showActions=true. */
  onDelete?: (host: SavedHost) => void;
}

export function SavedHostCard({
  host,
  selected = false,
  showActions = false,
  onClick,
  onRename,
  onDelete,
}: SavedHostCardProps) {
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <div
      className={cn(
        'group relative rounded-md border border-border bg-card overflow-hidden transition-[border-color,box-shadow,transform] duration-150',
        onClick && 'cursor-pointer hover:border-rule-strong hover:-translate-y-px hover:shadow-sm',
        selected &&
          'border-primary -translate-y-px shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_18%,transparent),var(--shadow-1)]',
      )}
      onClick={onClick ? () => onClick(host) : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(host);
        }
      }}
      data-testid="saved-host-card"
    >
      <div className="relative aspect-[3/4] bg-secondary overflow-hidden">
        {host.url && !imgFailed ? (
          <img
            src={host.url}
            alt={host.name}
            className="w-full h-full object-cover"
            onError={() => setImgFailed(true)}
            draggable={false}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-muted-foreground">
            <UserCircle className="size-10" strokeWidth={1.2} />
          </div>
        )}
        {showActions && (onRename || onDelete) && (
          <div
            className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
            // Stop card-click when interacting with the menu trigger.
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="grid place-items-center w-7 h-7 rounded-full bg-black/55 text-white hover:bg-black/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                  aria-label="옵션"
                  data-testid="saved-host-card-menu"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onRename && (
                  <DropdownMenuItem onClick={() => onRename(host)}>
                    <Pencil className="size-3.5 mr-2" />
                    이름 변경
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <DropdownMenuItem
                    onClick={() => onDelete(host)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="size-3.5 mr-2" />
                    삭제
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      <div className="px-2.5 py-2 border-t border-border">
        <div
          className={cn(
            'text-xs font-medium tracking-tight truncate',
            selected ? 'text-foreground font-bold' : 'text-ink-2',
          )}
        >
          {host.name}
        </div>
      </div>
    </div>
  );
}
