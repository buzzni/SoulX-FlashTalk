/**
 * TopBar — wizard + render header.
 *
 * Workspace mark + "HostStudio" wordmark + Korean step pills (1 / 2 / 3
 * with circular numbered dots, Korean labels). Visual styling lives in
 * studio/styles/app.css under `.topbar` / `.brand` / `.step-pill`.
 */
import { Fragment, type ReactNode, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { WizardButton as Button } from '@/components/wizard-button';
import { ProfileMenu } from './ProfileMenu';
import { getUser, subscribe } from '../stores/authStore';
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
  const user = useSyncExternalStore(subscribe, getUser, getUser);
  const display = user?.display_name || user?.user_id || 'F';
  const initial = (display[0] || 'F').toUpperCase();

  return (
    <header className="topbar">
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <Link to="/" className="brand" style={{ textDecoration: 'none', color: 'inherit' }} title="홈으로">
          <div className="brand-mark" aria-hidden>{initial}</div>
          <span>FlashTalk</span>
          <span className="brand-tag">AI 쇼호스트 영상</span>
        </Link>
        {step !== null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
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
                    <span className="dot" aria-hidden>
                      {done ? <Check className="size-3" /> : s.short}
                    </span>
                    <span className="step-pill-label">{s.name}</span>
                  </button>
                  {i < STEPS.length - 1 && <span className="step-arrow" aria-hidden />}
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
          처음부터
        </Button>
        <ProfileMenu />
      </div>
    </header>
  );
}
