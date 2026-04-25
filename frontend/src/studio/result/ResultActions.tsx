/**
 * ResultActions — 2×2 action grid on the result page.
 *
 * Completed: Download (native <a download>) + Copy share link +
 * Home + Make another.
 * Not-completed: all four buttons rendered disabled so layout doesn't
 * collapse (the result page is reachable for in-progress tasks during
 * the race window between dispatch and manifest write).
 */
import Icon from '../Icon.jsx';
import { WizardButton as Button } from '@/components/wizard-button';
export interface ResultActionsProps {
  isDone: boolean;
  taskId: string;
  copied: boolean;
  onCopyShare: () => void;
  onGoHome: () => void;
}

export function ResultActions({
  isDone,
  taskId,
  copied,
  onCopyShare,
  onGoHome,
}: ResultActionsProps) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 8,
        marginTop: 'auto',
      }}
    >
      {isDone ? (
        <>
          <a
            href={`/api/videos/${taskId}?download=true`}
            download
            className="inline-flex h-9 items-center justify-center gap-2 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors no-underline"
          >
            <Icon name="download" size={14} /> 내 컴퓨터에 저장
          </a>
          <Button icon={copied ? 'check' : 'link'} onClick={onCopyShare}>
            {copied ? '링크 복사됨' : '공유 링크 복사'}
          </Button>
          <Button icon="arrow_left" onClick={onGoHome}>
            처음으로
          </Button>
          <Button icon="plus" variant="primary" onClick={onGoHome}>
            영상 하나 더 만들기
          </Button>
        </>
      ) : (
        <>
          <Button variant="primary" icon="download" disabled>
            내 컴퓨터에 저장
          </Button>
          <Button icon="link" disabled>
            공유 링크 복사
          </Button>
          <Button icon="arrow_left" onClick={onGoHome}>
            처음으로
          </Button>
          <Button icon="plus" disabled>
            영상 하나 더 만들기
          </Button>
        </>
      )}
    </div>
  );
}
