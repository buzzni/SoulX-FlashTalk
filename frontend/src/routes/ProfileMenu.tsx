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
    <div ref={ref} style={wrapStyle}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={triggerStyle}
      >
        <span style={avatarStyle}>{(display[0] || '?').toUpperCase()}</span>
        <span style={nameStyle}>{display}</span>
        <span style={caretStyle}>▾</span>
      </button>
      {open && (
        <div role="menu" style={menuStyle}>
          <button role="menuitem" style={itemStyle} onClick={() => go('/mypage')}>
            마이페이지
          </button>
          <button role="menuitem" style={itemStyle} onClick={() => go('/results')}>
            내 영상들
          </button>
          <div style={dividerStyle} />
          <button role="menuitem" style={{ ...itemStyle, color: '#b00020' }} onClick={onLogout}>
            로그아웃
          </button>
        </div>
      )}
    </div>
  );
}

const wrapStyle: React.CSSProperties = { position: 'relative', display: 'inline-block' };

const triggerStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  background: 'transparent',
  border: '1px solid var(--border, #d0d0d6)',
  borderRadius: 999,
  cursor: 'pointer',
  font: 'inherit',
};

const avatarStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: '50%',
  background: '#3553ff',
  color: '#fff',
  fontSize: 12,
  fontWeight: 700,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const nameStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  maxWidth: 140,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const caretStyle: React.CSSProperties = { fontSize: 11, opacity: 0.6 };

const menuStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  minWidth: 160,
  background: '#fff',
  border: '1px solid #e5e5ea',
  borderRadius: 10,
  boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
  padding: 6,
  zIndex: 100,
};

const itemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '8px 12px',
  background: 'transparent',
  border: 'none',
  borderRadius: 6,
  fontSize: 13,
  cursor: 'pointer',
};

const dividerStyle: React.CSSProperties = {
  height: 1,
  background: '#eef',
  margin: '6px 0',
};
