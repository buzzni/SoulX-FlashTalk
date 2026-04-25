/**
 * StepFooter — prev/valid-msg/next row at the bottom of every wizard step.
 *
 * Lives in the WizardLayout rather than per-step so all three steps get
 * identical button geometry and validation-message styling.
 */
import Icon from '../studio/Icon.jsx';
import { WizardButton as Button } from '@/components/wizard-button';
import type { WizardValidity } from './wizardValidation';

export interface StepFooterProps {
  step: 1 | 2 | 3;
  valid: WizardValidity;
  onPrev: () => void;
  onNext: () => void;
}

export function StepFooter({ step, valid, onPrev, onNext }: StepFooterProps) {
  const canProceed = valid[step];
  const allValid = valid[1] && valid[2] && valid[3];
  const nextDisabled = !canProceed || (step === 3 && !allValid);

  return (
    <div className="step-footer">
      <Button icon="arrow_left" onClick={onPrev} disabled={step === 1}>
        이전
      </Button>
      <div className="validation-msg">
        {!canProceed && (
          <>
            <Icon name="alert_circle" size={13} style={{ color: 'var(--warn)' }} />
            <span>
              {step === 1 && '쇼호스트를 만들고 마음에 드는 후보를 하나 골라주세요'}
              {step === 2 && '제품·배경을 넣고 합성 이미지를 하나 골라주세요'}
              {step === 3 && '목소리와 대본, 영상 화질을 모두 설정해주세요'}
            </span>
          </>
        )}
        {canProceed && step < 3 && (
          <>
            <Icon name="check_circle" size={13} style={{ color: 'var(--success)' }} />
            <span>좋아요! 다음 단계로 넘어가세요</span>
          </>
        )}
        {canProceed && step === 3 && allValid && (
          <>
            <Icon name="check_circle" size={13} style={{ color: 'var(--success)' }} />
            <span>모든 준비 완료! 영상을 만들어볼까요?</span>
          </>
        )}
      </div>
      <Button
        variant="primary"
        iconRight={step === 3 ? 'video' : 'arrow_right'}
        onClick={onNext}
        disabled={nextDisabled}
      >
        {step === 3 ? '영상 만들기 시작' : '다음 단계'}
      </Button>
    </div>
  );
}
