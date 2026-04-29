/**
 * Sidebar — primary navigation for the productivity shell.
 *
 * Workspace identity at top, prominent "+ 새 영상 만들기" CTA, then nav
 * groups. Bottom utility links (도움말 / 설정). All-Korean — no English
 * mono labels. Active item gets a soft surface background + signal-blue
 * icon tint.
 */
import { Link, useNavigate } from 'react-router-dom';
import {
  Home,
  Folder,
  FolderOpen,
  Plus,
  Play,
  HelpCircle,
  Settings,
  Users,
} from 'lucide-react';
import { Brand } from '../components/brand';
import { useStartNewVideo } from '../components/start-new-video';
import { useLastSavedAt } from '../stores/wizardStore';
import { useSavedHostCount } from '../api/queries/use-saved-hosts';
import { cn } from '@/lib/utils';
import {
  formatDraftAge,
  resumeVideo,
  useDraftAgeTick,
} from '../lib/wizardNav';

interface SidebarProps {
  active: 'home' | 'results' | 'mypage' | 'hosts';
}

export function Sidebar({ active }: SidebarProps) {
  const navigate = useNavigate();
  const lastSavedAt = useLastSavedAt();
  useDraftAgeTick(lastSavedAt != null);
  const { start: handleStartNew, modal: startNewModal } = useStartNewVideo();
  const savedHostCount = useSavedHostCount();

  return (
    <aside className="hidden md:flex md:sticky md:top-0 md:h-screen flex-col bg-sidebar-background border-r border-sidebar-border px-3.5 py-4 overflow-y-auto">
      <Brand
        size="md"
        to="/"
        title="홈으로"
        className="px-1.5 mb-3"
      />

      <button
        type="button"
        onClick={handleStartNew}
        title="새 영상 만들기 (3단계 위저드)"
        className="flex items-center gap-2 w-full px-3 py-2.5 mb-2 bg-foreground text-background rounded-md font-semibold text-sm-tight tracking-tight transition-colors hover:bg-foreground/85 cursor-pointer"
      >
        <Plus className="size-4" />
        <span>새 영상 만들기</span>
      </button>
      {startNewModal}

      {lastSavedAt != null && (
        <button
          type="button"
          onClick={() => resumeVideo(navigate)}
          title="진행 중인 작업 이어서 만들기"
          className="flex items-center justify-between gap-2 w-full px-3 py-2 mb-2 bg-card border border-border rounded-md text-xs font-semibold text-foreground tracking-tight transition-colors hover:bg-surface-2 cursor-pointer"
        >
          <span className="flex items-center gap-2 min-w-0">
            <Play className="size-3.5 text-primary shrink-0" />
            <span className="truncate">이어 만들기</span>
          </span>
          <span className="text-2xs text-muted-foreground tracking-tight shrink-0">
            {formatDraftAge(lastSavedAt)}
          </span>
        </button>
      )}

      <NavGroup label="작업">
        <NavItem
          to="/"
          label="홈"
          icon={<Home className="size-4" />}
          active={active === 'home'}
        />
        <NavItem
          to="/results"
          label="내 영상들"
          icon={
            active === 'results' ? (
              <FolderOpen className="size-4" />
            ) : (
              <Folder className="size-4" />
            )
          }
          active={active === 'results'}
        />
        <NavItem
          to="/hosts"
          label="나의 쇼호스트"
          icon={<Users className="size-4" />}
          active={active === 'hosts'}
          count={savedHostCount > 0 ? savedHostCount : undefined}
        />
        {/* "진행 중" item removed — link was /render (dispatch-new),
         * not a list of in-flight tasks. Real queue lives in the
         * topbar "작업" Popover. */}
      </NavGroup>

      <div className="flex-1" />

      <NavGroup label={null}>
        <NavItem
          to="/mypage"
          label="내 정보"
          icon={<Settings className="size-4" />}
          active={active === 'mypage'}
          quiet
        />
        <NavItem
          to="#"
          label="도움말"
          icon={<HelpCircle className="size-4" />}
          quiet
        />
      </NavGroup>

    </aside>
  );
}

interface NavGroupProps {
  label: string | null;
  children: React.ReactNode;
}

function NavGroup({ label, children }: NavGroupProps) {
  return (
    <div className="mt-3">
      {label && (
        <div className="text-2xs font-semibold text-muted-foreground tracking-tight px-3 py-1.5">
          {label}
        </div>
      )}
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

interface NavItemProps {
  to: string;
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  quiet?: boolean;
  count?: number;
  dim?: boolean;
}

function NavItem({ to, label, icon, active, quiet, count, dim }: NavItemProps) {
  const cls = active
    ? 'bg-card text-foreground shadow-[var(--shadow-soft)]'
    : quiet
      ? 'text-muted-foreground hover:bg-card hover:text-foreground'
      : 'text-ink-2 hover:bg-card hover:text-foreground';
  return (
    <Link
      to={to}
      className={cn(
        'flex items-center justify-between gap-2 px-3 py-2 rounded-md no-underline text-sm-tight font-medium tracking-tight transition-colors',
        cls,
        dim && 'opacity-60',
      )}
    >
      <span className="flex items-center gap-2.5 min-w-0">
        <span className={cn('shrink-0', active ? 'text-primary' : 'text-muted-foreground')}>
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </span>
      {typeof count === 'number' && (
        <span className="text-2xs text-muted-foreground tabular-nums">{count}</span>
      )}
    </Link>
  );
}
