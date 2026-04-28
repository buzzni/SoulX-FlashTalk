/**
 * TopBar — wizard + render header.
 *
 * Brand lockup + Korean step pills (1 / 2 / 3 with circular numbered
 * dots, Korean labels). The shell (`.topbar`) still lives in
 * studio/styles/app.css; the per-pill visual is now React-state-driven
 * Tailwind utilities rather than `.step-pill.active` / `.step-pill.done`
 * BEM, which makes the active/done/disabled states obvious from the
 * component instead of from a global stylesheet.
 */
import { Fragment, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { WizardButton as Button } from '@/components/wizard-button';
import { ProfileMenu } from './ProfileMenu';
import { Brand } from '../components/brand';
import { cn } from '@/lib/utils';
import type { WizardValidity } from './wizardValidation';

export const STEPS = [
  { key: 1, name: '쇼호스트', short: '1', full: '쇼호스트 만들기' },
  { key: 2, name: '제품·배경', short: '2', full: '제품과 배경' },
  { key: 3, name: '목소리·영상', short: '3', full: '목소리와 영상 뽑기' },
] as const;

export interface TopBarProps {
  step: 1 | 2 | 3 | null;
  valid?: WizardValidity;
  onStepClick?: (step: 1 | 2 | 3) => void;
  onReset: () => void;
  queueSlot: ReactNode;
}

export function TopBar({ step, valid, onStepClick, onReset, queueSlot }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="flex items-center gap-5">
        <Brand size="md" to="/" title="홈으로" />
        {step !== null && (
          <div className="flex items-center gap-1 ml-2">
            {STEPS.map((s, i) => {
              const active = step === s.key;
              const done = valid?.[s.key] && step > s.key;
              // Match WizardLayout.handleStepClick reachability: step 1
              // is always reachable, step 2 needs valid[1], step 3 needs
              // valid[2]. Active step is treated as reachable so the
              // current pill never looks blocked.
              const reachable =
                active ||
                s.key === 1 ||
                (s.key === 2 && !!valid?.[1]) ||
                (s.key === 3 && !!valid?.[2]);
              const disabled = !reachable;
              return (
                <Fragment key={s.key}>
                  <button
                    type="button"
                    onClick={() => onStepClick?.(s.key)}
                    title={s.full}
                    aria-current={active ? 'step' : undefined}
                    aria-disabled={disabled || undefined}
                    disabled={disabled}
                    className={cn(
                      'flex items-center gap-2 whitespace-nowrap py-1.5 pr-3 pl-2 rounded-full bg-transparent border-0 text-[13px] font-medium transition-colors',
                      // Hover only when not active — active stays on the
                      // primary-soft fill instead of swapping to bg-secondary.
                      !active &&
                        'enabled:hover:text-foreground enabled:hover:bg-secondary',
                      'disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2',
                      active
                        ? 'text-foreground bg-primary-soft'
                        : done
                          ? 'text-ink-2'
                          : 'text-muted-foreground',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'w-[22px] h-[22px] rounded-full grid place-items-center text-[11px] font-bold transition-all border-[1.5px] tracking-tight font-sans',
                        active
                          ? 'bg-primary border-primary text-white'
                          : done
                            ? 'bg-primary-soft border-primary text-primary'
                            : 'bg-transparent border-rule-strong text-muted-foreground',
                      )}
                    >
                      {done ? <Check className="size-3" /> : s.short}
                    </span>
                    <span
                      className={cn(
                        'text-[13px] tracking-tight',
                        active ? 'font-bold' : 'font-medium',
                      )}
                    >
                      {s.name}
                    </span>
                  </button>
                  {i < STEPS.length - 1 && (
                    <span aria-hidden className="w-4 h-px bg-border mx-1 self-center" />
                  )}
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
      <div className="topbar-right">
        {queueSlot}
        <Button size="sm" icon="refresh" onClick={onReset}>
          처음부터
        </Button>
        <ProfileMenu />
      </div>
    </header>
  );
}
