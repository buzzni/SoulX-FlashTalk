/**
 * ProfileMenu — top-right user chip with dropdown.
 *
 * Shows avatar + name on the chip. The dropdown reveals role +
 * subscription pills, theme toggle, then nav items. Logout uses the
 * destructive variant.
 */
import { useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ChevronDown, Moon, Sun, User, FolderOpen, LogOut } from 'lucide-react';
import { getUser, logout, subscribe } from '../stores/authStore';
import { getTheme, subscribeTheme, toggleTheme } from '../lib/theme';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ProfileMenu() {
  const navigate = useNavigate();
  const user = useSyncExternalStore(subscribe, getUser, getUser);
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
  const display = user?.display_name || user?.user_id || '게스트';
  const initial = (display[0] || '?').toUpperCase();
  const subs = user?.subscriptions || [];
  const role = user?.role || 'member';

  async function onLogout() {
    try {
      await logout();
      toast.success('로그아웃했어요');
    } catch {
      /* ignore */
    }
    navigate('/login', { replace: true });
  }

  function onToggleTheme() {
    toggleTheme();
    toast.success(theme === 'dark' ? '라이트 모드로 바꿨어요' : '다크 모드로 바꿨어요');
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="내 정보, 설정, 로그아웃"
          className="group inline-flex items-center gap-2 h-9 pl-1 pr-3 rounded-full bg-card border border-border text-foreground text-[13px] transition-all shadow-[var(--shadow-soft)] hover:border-rule-strong cursor-pointer"
        >
          <span
            aria-hidden
            className="grid place-items-center w-7 h-7 rounded-full bg-primary text-primary-foreground font-bold text-[12px]"
          >
            {initial}
          </span>
          <span className="font-semibold tracking-[-0.012em] max-w-[140px] truncate">
            {display}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[240px]">
        <div className="px-3 py-3 flex items-center gap-3">
          <span
            aria-hidden
            className="grid place-items-center w-10 h-10 rounded-full bg-primary text-primary-foreground font-bold text-[15px]"
          >
            {initial}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-bold text-[14px] tracking-[-0.014em] truncate">{display}</div>
            <div className="text-[11px] text-muted-foreground truncate">{user?.user_id || ''}</div>
          </div>
        </div>
        <div className="px-3 pb-2 flex flex-wrap gap-1">
          <span className="pill-neutral">{roleLabel(role)}</span>
          {subs.map((s) => (
            <span key={s} className="pill-primary">{s}</span>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onToggleTheme} className="gap-2">
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          {theme === 'dark' ? '라이트 모드' : '다크 모드'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/mypage')} className="gap-2">
          <User className="size-4" /> 내 정보
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/results')} className="gap-2">
          <FolderOpen className="size-4" /> 내 영상들
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onLogout} variant="destructive" className="gap-2">
          <LogOut className="size-4" /> 로그아웃
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function roleLabel(role: string): string {
  switch (role) {
    case 'admin': return '관리자';
    case 'member': return '멤버';
    case 'studio': return '스튜디오';
    default: return role;
  }
}
