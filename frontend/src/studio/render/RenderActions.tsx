/**
 * RenderActions — 2×2 action grid at the bottom of the render card.
 *
 * Row 1 — 저장 + 공유 (what you do WITH the finished video)
 * Row 2 — 수정 + 새로 (what you do NEXT)
 *
 * In the in-flight / error state, all four buttons render disabled
 * (except 수정 when the job errored — user should still be able to
 * back out and try again).
 */

import Icon from '../Icon.jsx';
import { WizardButton as Button } from '@/components/wizard-button';
export interface RenderActionsProps {
  status: 'pending' | 'rendering' | 'done' | 'error';
  playableVideoUrl: string | null;
  downloadUrl: string | null;
  copied: boolean;
  onCopyShare: () => void;
  onBack: () => void;
  onReset: () => void;
}

export function RenderActions({
  status,
  playableVideoUrl,
  downloadUrl,
  copied,
  onCopyShare,
  onBack,
  onReset,
}: RenderActionsProps) {
  if (status === 'done' && playableVideoUrl) {
    return (
      <div className="grid grid-cols-2 gap-2 mt-auto">
        <a
          href={downloadUrl ?? playableVideoUrl}
          download
          className="inline-flex h-9 items-center justify-center gap-2 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-[var(--primary-hover)] transition-colors no-underline"
        >
          <Icon name="download" size={14} /> 내 컴퓨터에 저장
        </a>
        <Button icon={copied ? 'check' : 'link'} onClick={onCopyShare}>
          {copied ? '링크 복사됨' : '공유 링크 복사'}
        </Button>
        <Button icon="refresh" onClick={onBack}>
          고쳐서 다시 만들기
        </Button>
        <Button icon="plus" variant="primary" onClick={onReset}>
          영상 하나 더 만들기
        </Button>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2 mt-auto">
      <Button variant="primary" icon="download" disabled>
        내 컴퓨터에 저장
      </Button>
      <Button icon="link" disabled>
        공유 링크 복사
      </Button>
      <Button icon="refresh" disabled={status !== 'error'} onClick={onBack}>
        고쳐서 다시 만들기
      </Button>
      <Button icon="plus" disabled onClick={onReset}>
        영상 하나 더 만들기
      </Button>
    </div>
  );
}
