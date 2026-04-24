/**
 * TopBar — shared header for wizard + render views.
 *
 * - `step` null hides the step pills (render view uses this).
 * - Step pills are clickable but only for steps the user has already
 *   satisfied; clicking an unsatisfied step is a no-op so users can't
 *   deep-jump past missing prerequisites.
 */
import { Fragment, type ReactNode } from 'react';
import Icon from '../studio/Icon.jsx';
import { Button } from '../studio/primitives.jsx';
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
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
        {step !== null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 10 }}>
            {STEPS.map((s, i) => {
              const active = step === s.key;
              const done = valid?.[s.key] && step > s.key;
              return (
                <Fragment key={s.key}>
                  <button
                    type="button"
                    className={`step-pill ${active ? 'active' : ''} ${done ? 'done' : ''}`}
                    onClick={() => onStepClick?.(s.key)}
                    title={s.full}
                    aria-current={active ? 'step' : undefined}
                  >
                    <span className="dot">
                      {done ? <Icon name="check" size={10} /> : s.short}
                    </span>
                    <span className="step-pill-label">{s.name}</span>
                  </button>
                  {i < STEPS.length - 1 && <span className="step-arrow" />}
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
      <div className="topbar-right">
        <span className="meta">자동 저장됨</span>
        {queueSlot}
        <Button size="sm" icon="refresh" onClick={onReset}>
          처음부터 다시
        </Button>
      </div>
    </header>
  );
}
