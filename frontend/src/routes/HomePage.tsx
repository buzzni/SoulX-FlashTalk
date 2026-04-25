/**
 * / — minimal home with two big actions: make a new video, or browse
 * past results. Future: hero / landing copy on top of the same shell.
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
      <main className="flex-1 flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-3xl rounded-2xl surface-base p-12 text-center shadow-[0_4px_24px_rgba(0,0,0,0.04)] animate-fade-in">
          {greeting && (
            <p className="text-sm text-muted-foreground">
              안녕하세요, {greeting} 님
            </p>
          )}
          <h1 className="mt-2 mb-8 text-3xl font-bold tracking-tight">
            무엇을 할까요?
          </h1>
          <div className="grid gap-4 sm:grid-cols-2">
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
  const base =
    'flex items-center gap-4 px-7 py-6 rounded-xl text-left cursor-pointer transition-all duration-100 hover:-translate-y-0.5 active:translate-y-0';
  const variantClass =
    variant === 'primary'
      ? 'bg-primary text-primary-foreground shadow-[0_4px_16px_rgba(0,93,255,0.25)] hover:shadow-[0_6px_20px_rgba(0,93,255,0.32)]'
      : 'bg-muted text-foreground shadow-[0_2px_8px_rgba(0,0,0,0.04)] hover:bg-accent/40';
  const iconBg =
    variant === 'primary'
      ? 'bg-white/15 text-primary-foreground'
      : 'bg-card text-primary';

  return (
    <button type="button" onClick={onClick} className={`${base} ${variantClass}`}>
      <div className={`grid place-items-center w-11 h-11 rounded-lg shrink-0 ${iconBg}`}>
        <Icon name={iconName} size={20} />
      </div>
      <div>
        <div className="text-lg font-bold mb-0.5">{title}</div>
        <div className={`text-[13px] ${variant === 'primary' ? 'opacity-90' : 'text-muted-foreground'}`}>
          {subtitle}
        </div>
      </div>
    </button>
  );
}
