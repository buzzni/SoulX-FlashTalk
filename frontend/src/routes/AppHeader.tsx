/**
 * AppHeader — minimal top bar for non-wizard pages (Home, MyPage,
 * Results list). Brand mark on the left, ProfileMenu on the right.
 *
 * The wizard's TopBar carries the full step-pill apparatus and queue
 * badge — this one is for everything else. It uses Tailwind utilities
 * tied to the global design tokens so it stays in sync with the rest
 * of the non-wizard surface area.
 */
import { Link } from 'react-router-dom';
import { ProfileMenu } from './ProfileMenu';

export function AppHeader() {
  return (
    <header className="flex items-center justify-between min-h-[56px] px-5 bg-card border-b border-border">
      <Link to="/" className="no-underline text-foreground">
        <div className="flex items-center gap-2.5 text-sm font-semibold tracking-tight">
          <span
            aria-hidden
            className="relative grid place-items-center w-[22px] h-[22px] rounded-md bg-foreground text-card text-[11px] font-bold"
          >
            H
            <span className="absolute -right-[3px] -bottom-[3px] w-2 h-2 rounded-full bg-primary border-2 border-card" />
          </span>
          <span>HostStudio</span>
          <span className="hidden md:inline ml-1.5 pl-2.5 border-l border-border text-xs text-muted-foreground font-normal">
            AI 쇼호스트 영상
          </span>
        </div>
      </Link>
      <div className="flex items-center gap-2">
        <ProfileMenu />
      </div>
    </header>
  );
}
