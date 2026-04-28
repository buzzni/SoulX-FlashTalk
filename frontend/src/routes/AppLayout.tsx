/**
 * AppLayout — sidebar shell for non-wizard pages.
 *
 * 248px sidebar (workspace mark + new-video CTA + nav + bottom utilities)
 * + main content column. Profile chip floats top-right inside main. The
 * wizard uses its own TopBar layout — no sidebar there because wizard is
 * a focus mode.
 */
import { type ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { ProfileMenu } from './ProfileMenu';
import QueueStatus from '../studio/QueueStatus';

interface AppLayoutProps {
  children: ReactNode;
  /** Optional active nav key for the sidebar — 'home' | 'results' | 'mypage' */
  active?: 'home' | 'results' | 'mypage';
}

export function AppLayout({ children, active = 'home' }: AppLayoutProps) {
  return (
    <div className="min-h-screen grid grid-cols-1 md:grid-cols-[248px_1fr] bg-background">
      <Sidebar active={active} />
      <main className="relative min-h-screen overflow-x-hidden">
        <div className="fixed top-4 right-5 md:right-8 z-20 flex items-center gap-2">
          <QueueStatus />
          <ProfileMenu />
        </div>
        {children}
      </main>
    </div>
  );
}
