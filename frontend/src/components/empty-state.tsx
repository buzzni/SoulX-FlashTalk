import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  FilmIcon,
  ListMusic,
  SearchX,
  Inbox,
  AlertCircle,
  Sparkles,
} from 'lucide-react';

/**
 * EmptyState — context-varied empty placeholders.
 *
 * Replaces the "generic Sparkles + same message" pattern. Each kind has
 * its own icon + tone:
 *   - 'no-videos':  film icon + creator-encouraging copy
 *   - 'no-results': search-x icon + filter-related copy
 *   - 'no-playlist-items': list-music icon
 *   - 'inbox':       inbox icon (generic empty list)
 *   - 'error':       alert-circle (failure state)
 *   - 'preview':     sparkles (preview pending)
 */
type Kind = 'no-videos' | 'no-results' | 'no-playlist-items' | 'inbox' | 'error' | 'preview';

const KIND_ICON: Record<Kind, React.ComponentType<{ className?: string }>> = {
  'no-videos': FilmIcon,
  'no-results': SearchX,
  'no-playlist-items': ListMusic,
  inbox: Inbox,
  error: AlertCircle,
  preview: Sparkles,
};

const KIND_TINT: Record<Kind, string> = {
  'no-videos': 'text-primary',
  'no-results': 'text-muted-foreground',
  'no-playlist-items': 'text-primary',
  inbox: 'text-muted-foreground',
  error: 'text-destructive',
  preview: 'text-muted-foreground',
};

export interface EmptyStateProps {
  kind: Kind;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({
  kind,
  title,
  description,
  action,
  className,
  compact,
}: EmptyStateProps) {
  const Icon = KIND_ICON[kind];
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'py-8 gap-2' : 'py-14 gap-3',
        className,
      )}
    >
      <div
        className={cn(
          'grid place-items-center rounded-full bg-secondary',
          compact ? 'size-10' : 'size-14',
          KIND_TINT[kind],
        )}
      >
        <Icon className={compact ? 'size-5' : 'size-6'} />
      </div>
      <div className="flex flex-col gap-1 max-w-sm">
        <p className={cn('m-0 font-semibold tracking-[-0.014em]', compact ? 'text-[14px]' : 'text-[15px]')}>
          {title}
        </p>
        {description && (
          <p className={cn('m-0 text-muted-foreground', compact ? 'text-[12px]' : 'text-[13px]')}>
            {description}
          </p>
        )}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
