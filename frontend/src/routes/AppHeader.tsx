/**
 * AppHeader — minimal top bar for non-wizard pages (Home, MyPage,
 * Results list). Just the brand mark + ProfileMenu. The wizard's TopBar
 * carries the full step-pill apparatus and a queue badge; this one's
 * for everything else.
 */
import { Link } from 'react-router-dom';
import { ProfileMenu } from './ProfileMenu';

export function AppHeader() {
  return (
    <header className="topbar">
      <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="brand">
          <div className="brand-mark">H</div>
          <span>HostStudio</span>
          <span
            className="brand-tag text-xs text-tertiary"
            style={{ marginLeft: 6, paddingLeft: 10, borderLeft: '1px solid var(--border)' }}
          >
            AI 쇼호스트 영상
          </span>
        </div>
      </Link>
      <div className="topbar-right">
        <ProfileMenu />
      </div>
    </header>
  );
}
