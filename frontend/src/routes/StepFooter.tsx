/**
 * StepFooter — sticky prev/next bar at the bottom of every wizard step.
 *
 * Visual hierarchy:
 *  - Left:  이전 (small outline)
 *  - Center: validation message (error icon + actionable copy)
 *  - Right: 다음 단계 (primary, bold, with arrow)
 *
 * When `valid[step]` is false, the next button is disabled and the
 * center message tells the user what's still missing. When valid, the
 * center turns into a positive cue and the next button glows.
 */
import { ArrowLeft, ArrowRight, AlertCircle, Check, Video } from 'lucide-react';
import type { WizardValidity } from './wizardValidation';
import { AutoSaveIndicator } from '../components/auto-save-indicator';

export interface StepFooterProps {
  step: 1 | 2 | 3;
  valid: WizardValidity;
  onPrev: () => void;
  onNext: () => void;
}

const MISSING: Record<1 | 2 | 3, string> = {
  1: '쇼호스트를 만들고 마음에 드는 후보를 하나 골라주세요',
  2: '제품·배경을 넣고 합성 이미지를 하나 골라주세요',
  3: '목소리와 대본, 영상 화질을 모두 설정해주세요',
};

export function StepFooter({ step, valid, onPrev, onNext }: StepFooterProps) {
  const canProceed = valid[step];
  const allValid = valid[1] && valid[2] && valid[3];
  const isLast = step === 3;
  const nextDisabled = !canProceed || (isLast && !allValid);

  return (
    <div className="step-footer">
      <div className="inline-flex items-center gap-3">
        <button
          type="button"
          onClick={onPrev}
          disabled={step === 1}
          className="inline-flex items-center gap-1.5 h-10 px-4 rounded-md border border-input bg-card text-foreground text-[13px] font-semibold hover:border-rule-strong disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          <ArrowLeft className="size-4" /> 이전
        </button>
        <AutoSaveIndicator />
      </div>

      <div className="flex-1 flex items-center justify-center min-w-0 px-4">
        {!canProceed && (
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-soft text-amber-on-soft text-[12.5px] font-medium">
            <AlertCircle className="size-3.5 shrink-0" />
            <span className="truncate">{MISSING[step]}</span>
          </div>
        )}
        {canProceed && !isLast && (
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-success-soft text-success-on-soft text-[12.5px] font-medium">
            <Check className="size-3.5" />
            <span>좋아요! 다음 단계로 넘어가세요</span>
          </div>
        )}
        {canProceed && isLast && allValid && (
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-success-soft text-success-on-soft text-[12.5px] font-medium">
            <Check className="size-3.5" />
            <span>모든 준비 완료! 영상을 만들어볼까요?</span>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        className={`inline-flex items-center gap-2 h-10 px-5 rounded-md text-[13.5px] font-bold transition-all cursor-pointer ${
          nextDisabled
            ? 'bg-secondary text-muted-foreground cursor-not-allowed'
            : 'bg-primary text-primary-foreground hover:bg-[var(--primary-hover)] shadow-[0_2px_8px_-2px_var(--primary-soft)]'
        }`}
      >
        {isLast ? (
          <>
            <Video className="size-4" />
            <span>영상 만들기 시작</span>
          </>
        ) : (
          <>
            <span>다음 단계</span>
            <ArrowRight className="size-4" />
          </>
        )}
      </button>
    </div>
  );
}
