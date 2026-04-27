/**
 * Sidebar — primary navigation for the productivity shell.
 *
 * Workspace identity at top, prominent "+ 새 영상 만들기" CTA, then nav
 * groups. Bottom utility links (도움말 / 설정). All-Korean — no English
 * mono labels. Active item gets a soft surface background + signal-blue
 * icon tint.
 */
import { useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Home,
  FolderOpen,
  Plus,
  Play,
  HelpCircle,
  Settings,
  Moon,
  Sun,
} from 'lucide-react';
import { getTheme, subscribeTheme, toggleTheme } from '../lib/theme';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Brand } from '../components/brand';
import { useLastSavedAt } from '../stores/wizardStore';
import {
  formatDraftAge,
  resumeVideo,
  startNewVideo,
  useDraftAgeTick,
} from '../lib/wizardNav';

interface SidebarProps {
  active: 'home' | 'results' | 'mypage';
}

export function Sidebar({ active }: SidebarProps) {
  const navigate = useNavigate();
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
  const lastSavedAt = useLastSavedAt();
  useDraftAgeTick(lastSavedAt != null);

  return (
    <aside className="hidden md:flex md:sticky md:top-0 md:h-screen flex-col bg-sidebar-background border-r border-sidebar-border px-3.5 py-4 overflow-y-auto">
      <Brand
        size="sm"
        to="/"
        title="홈으로"
        className="px-2 py-2 mb-3 rounded-md hover:bg-card transition-colors"
      />

      <button
        type="button"
        onClick={() => startNewVideo(navigate)}
        title="새 영상 만들기 (3단계 위저드)"
        className="flex items-center gap-2 w-full px-3 py-2.5 mb-2 bg-foreground text-background rounded-md font-semibold text-[13px] tracking-[-0.014em] transition-colors hover:bg-foreground/85 cursor-pointer"
      >
        <Plus className="size-4" />
        <span>새 영상 만들기</span>
      </button>

      {lastSavedAt != null && (
        <button
          type="button"
          onClick={() => resumeVideo(navigate)}
          title="진행 중인 작업 이어서 만들기"
          className="flex items-center justify-between gap-2 w-full px-3 py-2 mb-2 bg-card border border-border rounded-md text-[12.5px] font-semibold text-foreground tracking-[-0.012em] transition-colors hover:bg-surface-2 cursor-pointer"
        >
          <span className="flex items-center gap-2 min-w-0">
            <Play className="size-3.5 text-primary shrink-0" />
            <span className="truncate">이어 만들기</span>
          </span>
          <span className="text-[11px] text-muted-foreground tracking-[-0.005em] shrink-0">
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
          icon={<FolderOpen className="size-4" />}
          active={active === 'results'}
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

      {/* Theme toggle pinned at the bottom */}
      <div className="mt-3 pt-3 border-t border-sidebar-border flex items-center justify-between px-2">
        <span className="text-[11px] text-muted-foreground tracking-[-0.005em]">테마</span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => toggleTheme()}
                aria-label="다크 모드 전환"
                className="grid place-items-center size-7 rounded-md text-muted-foreground hover:bg-card hover:text-foreground transition-colors cursor-pointer"
              >
                {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              {theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
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
        <div className="text-[11px] font-semibold text-muted-foreground tracking-[-0.005em] px-3 py-1.5">
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
      className={`flex items-center justify-between gap-2 px-3 py-2 rounded-md no-underline text-[13.5px] font-medium tracking-[-0.012em] transition-colors ${cls} ${dim ? 'opacity-60' : ''}`}
    >
      <span className="flex items-center gap-2.5 min-w-0">
        <span className={`shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`}>
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </span>
      {typeof count === 'number' && (
        <span className="text-[11px] text-muted-foreground tabular-nums">{count}</span>
      )}
    </Link>
  );
}
