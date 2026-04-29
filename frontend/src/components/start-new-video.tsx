/**
 * useStartNewVideo — entry-point CTA gate for "새 영상 만들기".
 *
 * 진행 중인 draft가 있으면 ConfirmModal을 띄워 사용자가 모르고 작업을
 * 날리지 않게 한다. 없으면 즉시 위저드를 초기화하고 step 1로 이동.
 *
 * 사용처: 홈/사이드바/결과목록의 "새 영상" CTA. RenderLayout은 자체
 * "처음부터 다시" 모달이 있고, WizardLayout 내부 reset은 위저드 안의
 * 의도적 reset이라 같은 가드를 두지 않는다.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConfirmModal } from './confirm-modal';
import { useLastSavedAt } from '../stores/wizardStore';
import { startNewVideo } from '../lib/wizardNav';

export function useStartNewVideo(): { start: () => void; modal: React.ReactNode } {
  const navigate = useNavigate();
  const lastSavedAt = useLastSavedAt();
  const [open, setOpen] = useState(false);

  const start = () => {
    if (lastSavedAt != null) setOpen(true);
    else startNewVideo(navigate);
  };

  const modal = (
    <ConfirmModal
      open={open}
      title="진행 중인 작업이 있어요"
      description="새 영상을 만들면 지금까지 작업한 내용은 사라져요. 그래도 새로 시작할까요?"
      confirmLabel="새로 시작"
      cancelLabel="취소"
      variant="danger"
      onConfirm={() => {
        setOpen(false);
        startNewVideo(navigate);
      }}
      onCancel={() => setOpen(false)}
    />
  );

  return { start, modal };
}
