/**
 * /hosts — 나의 쇼호스트 라이브러리.
 *
 * PR1 ships a placeholder so the sidebar entry routes somewhere; PR2
 * fills in the grid + rename/delete UX. Splitting the work this way
 * lets PR1 stand alone (sidebar item is meaningful — clicks land on a
 * "you'll see hosts here" empty state instead of a dead link).
 */
import { Users } from 'lucide-react';
import { AppLayout } from './AppLayout';
import { useStartNewVideo } from '../components/start-new-video';
import { WizardButton as Button } from '@/components/wizard-button';

export function HostsLibraryPage() {
  const { start, modal } = useStartNewVideo();
  return (
    <AppLayout active="hosts">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">나의 쇼호스트</h1>
          <p className="mt-1 text-sm-tight text-muted-foreground">
            저장한 쇼호스트로 새 영상을 빠르게 만들어요.
          </p>
        </header>

        {/* PR1 placeholder — PR2 swaps this for a saved-host grid (with
         *  rename/delete UX). The empty-state copy doubles as the
         *  zero-host UX which PR2 will keep showing when count==0. */}
        <div className="grid place-items-center rounded-lg border border-dashed border-border py-16 text-center">
          <div className="flex flex-col items-center gap-3 max-w-sm px-6">
            <Users className="size-8 text-muted-foreground" strokeWidth={1.5} />
            <h2 className="text-base font-semibold tracking-tight">
              저장된 호스트가 없어요
            </h2>
            <p className="text-sm-tight text-muted-foreground leading-relaxed">
              첫 영상을 만들고 1단계에서 마음에 드는 후보를{' '}
              <strong className="text-foreground">[내 호스트로 저장]</strong>해보세요.
            </p>
            <Button variant="primary" onClick={start}>
              새 영상 만들기
            </Button>
          </div>
        </div>
        {modal}
      </div>
    </AppLayout>
  );
}
