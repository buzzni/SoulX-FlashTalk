/**
 * ProfileMenu — top-right user dropdown.
 *
 * Shows display_name (or user_id fallback) as a chip; clicking opens a
 * menu with links to /mypage, /results, plus a divider and Logout.
 * Closes on outside click or ESC.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { getUser, logout, subscribe } from '../stores/authStore';

export function ProfileMenu() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Re-render when the auth store fires (login/logout/me changes).
  const user = useSyncExternalStore(subscribe, getUser, getUser);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const display = user?.display_name || user?.user_id || '게스트';

  async function onLogout() {
    setOpen(false);
    await logout();
    navigate('/login', { replace: true });
  }

  function go(path: string) {
    setOpen(false);
    navigate(path);
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-2 h-9 pl-1 pr-3 rounded-full border border-border bg-card text-foreground text-[13px] transition-colors hover:border-input hover:bg-secondary cursor-pointer"
      >
        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-[11px] font-bold">
          {(display[0] || '?').toUpperCase()}
        </span>
        <span className="font-medium max-w-[140px] truncate">{display}</span>
        <span className="text-[10px] text-muted-foreground">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-[calc(100%+6px)] right-0 min-w-[160px] panel-glass p-1.5 z-50 animate-fade-in"
        >
          <MenuItem onClick={() => go('/mypage')}>마이페이지</MenuItem>
          <MenuItem onClick={() => go('/results')}>내 영상들</MenuItem>
          <div className="h-px bg-border my-1.5" />
          <MenuItem onClick={onLogout} variant="danger">로그아웃</MenuItem>
        </div>
      )}
    </div>
  );
}

interface MenuItemProps {
  onClick: () => void;
  variant?: 'default' | 'danger';
  children: React.ReactNode;
}

function MenuItem({ onClick, variant = 'default', children }: MenuItemProps) {
  const color = variant === 'danger' ? 'text-destructive' : 'text-foreground';
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onClick}
      className={`block w-full text-left px-3 py-2 text-[13px] rounded transition-colors hover:bg-secondary cursor-pointer ${color}`}
    >
      {children}
    </button>
  );
}
