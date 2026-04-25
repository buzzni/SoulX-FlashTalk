/**
 * / — minimal home with two actions: make a new video, or browse past
 * results. Card density and shape match the wizard's .card primitive
 * (--r-lg radius, --pad-card padding, --shadow-xs) so the whole product
 * reads as one space.
 */
import { useNavigate } from 'react-router-dom';
import { useSyncExternalStore } from 'react';
import Icon from '../studio/Icon.jsx';
import { AppHeader } from './AppHeader';
import { getUser, subscribe } from '../stores/authStore';

export function HomePage() {
  const navigate = useNavigate();
  const user = useSyncExternalStore(subscribe, getUser, getUser);
  const greeting = user?.display_name || user?.user_id || '';

  return (
    <div className="min-h-screen flex flex-col bg-secondary">
      <AppHeader />
      <main className="flex-1 flex justify-center items-start px-4 md:px-6 pt-10 md:pt-16 pb-10">
        <div className="w-full max-w-2xl surface-base p-5 md:p-6 animate-fade-in">
          <h1 className="text-xl font-semibold tracking-tight leading-tight">
            {greeting ? `${greeting}님, ` : ''}무엇을 만들어볼까요?
          </h1>
          <p className="mt-1 mb-5 text-[13px] text-muted-foreground">
            호스트 영상부터 결과 관리까지 한 곳에서.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <ActionButton
              variant="primary"
              iconName="plus"
              title="영상 만들기"
              subtitle="호스트부터 영상까지 3단계"
              onClick={() => navigate('/step/1')}
            />
            <ActionButton
              variant="secondary"
              iconName="folder"
              title="내 영상들"
              subtitle="지금까지 만든 결과 보기"
              onClick={() => navigate('/results')}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

interface ActionButtonProps {
  variant: 'primary' | 'secondary';
  iconName: string;
  title: string;
  subtitle: string;
  onClick: () => void;
}

function ActionButton({ variant, iconName, title, subtitle, onClick }: ActionButtonProps) {
  // Action tiles, not form buttons — bigger than a wizard .btn but still
  // restrained. 16px corner radius, 16px padding, no decorative drop shadow.
  const base =
    'flex items-center gap-3 px-4 py-4 rounded-md text-left cursor-pointer transition-colors';
  const variantClass =
    variant === 'primary'
      ? 'bg-primary text-primary-foreground hover:bg-[var(--color-brand-primary-hover)]'
      : 'bg-secondary text-foreground border border-border hover:bg-muted';
  const iconBg =
    variant === 'primary'
      ? 'bg-white/15 text-primary-foreground'
      : 'bg-card text-primary border border-border';

  return (
    <button type="button" onClick={onClick} className={`${base} ${variantClass}`}>
      <div className={`grid place-items-center w-10 h-10 rounded-md shrink-0 ${iconBg}`}>
        <Icon name={iconName} size={18} />
      </div>
      <div className="min-w-0">
        <div className="text-[14px] font-semibold mb-0.5 truncate">{title}</div>
        <div className={`text-[12px] truncate ${variant === 'primary' ? 'opacity-85' : 'text-muted-foreground'}`}>
          {subtitle}
        </div>
      </div>
    </button>
  );
}
