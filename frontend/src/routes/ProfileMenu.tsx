/**
 * ProfileMenu — top-right user dropdown.
 *
 * Avatar chip trigger + shadcn DropdownMenu. The trigger keeps its pill
 * shape (consistent with the wizard's chip language); Radix handles the
 * portal, focus management, keyboard nav, and outside-click dismissal.
 */
import { useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { getUser, logout, subscribe } from '../stores/authStore';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ProfileMenu() {
  const navigate = useNavigate();
  const user = useSyncExternalStore(subscribe, getUser, getUser);
  const display = user?.display_name || user?.user_id || '게스트';

  async function onLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-2 h-9 pl-1 pr-3 rounded-full border border-border bg-card text-foreground text-[13px] transition-colors hover:border-input hover:bg-secondary cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-[11px] font-bold">
            {(display[0] || '?').toUpperCase()}
          </span>
          <span className="font-medium max-w-[140px] truncate">{display}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[160px]">
        <DropdownMenuItem onSelect={() => navigate('/mypage')}>
          마이페이지
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/results')}>
          내 영상들
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onLogout} variant="destructive">
          로그아웃
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
