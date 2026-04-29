/**
 * /mypage — account masthead + 설정.
 *
 * Profile info card + 정보 테이블 + 설정 (테마 토글, 알림) + 로그아웃.
 * 사이드바는 AppLayout.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { LogOut, Moon, Sun, Bell, BellOff, Monitor } from 'lucide-react';
import { AppLayout } from './AppLayout';
import { fetchJSON } from '../api/http';
import { schemas } from '../api/schemas-generated';
import { getUser, logout, subscribe } from '../stores/authStore';
import { getTheme, subscribeTheme, setTheme } from '../lib/theme';
import { storageKey } from '../stores/storageKey';
import { cn } from '@/lib/utils';

// User-scoped: storageKey('notify.enabled') resolves to
// 'showhost.notify.enabled.v1.<user_id>' so each user keeps their own
// preference. Logout clears it via allOwnedStorageKeys() purge.
const notifyKey = () => storageKey('notify.enabled');

function readNotify(): boolean {
  try {
    return localStorage.getItem(notifyKey()) !== 'off';
  } catch {
    return true;
  }
}

export function MyPage() {
  const navigate = useNavigate();
  const user = useSyncExternalStore(subscribe, getUser, getUser);
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
  const [videoCount, setVideoCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notify, setNotify] = useState<boolean>(readNotify);

  useEffect(() => {
    const ctl = new AbortController();
    fetchJSON('/api/history?limit=1000', {
      signal: ctl.signal,
      label: '활동 정보',
      schema: schemas.HistoryResponse,
    })
      .then((r) => setVideoCount(r.total))
      .catch(() => setVideoCount(null));
    return () => ctl.abort();
  }, []);

  async function onLogout() {
    setBusy(true);
    try {
      await logout();
      toast.success('로그아웃했어요');
    } catch {
      /* ignore */
    } finally {
      navigate('/login', { replace: true });
    }
  }

  function onToggleNotify() {
    const next = !notify;
    setNotify(next);
    try {
      localStorage.setItem(notifyKey(), next ? 'on' : 'off');
    } catch {
      /* ignore */
    }
    toast.success(next ? '알림을 켰어요' : '알림을 껐어요');
  }

  const subs = (user?.subscriptions || []).join(', ') || '—';
  const display = user?.display_name || user?.user_id || '나';
  const initial = (display[0] || '?').toUpperCase();

  return (
    <AppLayout active="mypage">
      <div className="px-6 md:px-12 pt-12 md:pt-16 pb-16 max-w-[720px] animate-rise">
        <div className="text-sm-tight text-muted-foreground mb-2">내 정보</div>
        <h1 className="headline-section m-0 mb-8">계정 설정</h1>

        {/* Profile card */}
        <div className="surface-card p-6 mb-4">
          <div className="flex items-center gap-4">
            <span
              aria-hidden
              className="grid place-items-center w-14 h-14 rounded-full bg-foreground text-background font-bold text-xl"
            >
              {initial}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-bold text-lg tracking-tighter truncate">
                {display}
              </div>
              <div className="text-sm-tight text-muted-foreground mt-0.5">
                쇼호스트 작업실에 로그인되어 있어요.
              </div>
            </div>
          </div>
        </div>

        {/* Info table */}
        <div className="surface-card p-1.5 mb-6">
          <Row label="아이디" value={user?.user_id || '—'} mono />
          <Row label="이름" value={user?.display_name || '—'} />
          <Row label="역할" value={user?.role || '—'} pill />
          <Row label="구독" value={subs} />
          <Row
            label="만든 영상"
            value={videoCount === null ? '—' : `${videoCount}`}
            suffix={videoCount === null ? '' : '개'}
            mono
            last
          />
        </div>

        {/* Settings — theme + notifications */}
        <h2 className="headline-row m-0 mb-3 text-sm">설정</h2>
        <div className="surface-card mb-6 divide-y divide-border">
          {/* Theme */}
          <SettingRow
            icon={theme === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
            label="테마"
            description="라이트·다크 또는 시스템에 맞춰 자동"
            control={
              <div className="inline-flex items-center bg-secondary border border-border p-0.5 rounded-md gap-0.5">
                <ThemeButton active={theme === 'light'} onClick={() => setTheme('light')} icon={<Sun className="size-3.5" />} label="라이트" />
                <ThemeButton active={theme === 'dark'} onClick={() => setTheme('dark')} icon={<Moon className="size-3.5" />} label="다크" />
                <ThemeButton active={false} onClick={() => {
                  // Reset to system
                  try { localStorage.removeItem('showhost.theme.v1'); } catch { /* ignore */ }
                  const sys = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                  setTheme(sys);
                  toast.success('시스템 설정 따라가기로 바꿨어요');
                }} icon={<Monitor className="size-3.5" />} label="시스템" />
              </div>
            }
          />

          {/* Notifications */}
          <SettingRow
            icon={notify ? <Bell className="size-4" /> : <BellOff className="size-4" />}
            label="작업 완료 알림"
            description="영상 생성·합성·음성 완료 시 toast 알림"
            control={
              <button
                type="button"
                onClick={onToggleNotify}
                aria-pressed={notify}
                className={cn(
                  'relative w-11 h-6 rounded-full transition-colors cursor-pointer',
                  notify ? 'bg-primary' : 'bg-rule-strong',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform',
                    notify ? 'translate-x-5' : 'translate-x-0',
                  )}
                />
              </button>
            }
          />
        </div>

        {/* Logout */}
        <button
          type="button"
          onClick={onLogout}
          disabled={busy}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-card border border-border rounded-md text-sm-tight font-semibold text-destructive hover:bg-destructive-soft hover:border-destructive/40 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          <LogOut className="size-4" />
          {busy ? '로그아웃 중…' : '로그아웃'}
        </button>
      </div>
    </AppLayout>
  );
}

interface RowProps {
  label: string;
  value: string;
  suffix?: string;
  mono?: boolean;
  pill?: boolean;
  last?: boolean;
}

function Row({ label, value, suffix, mono, pill, last }: RowProps) {
  return (
    <div className={cn('grid grid-cols-[100px_1fr] md:grid-cols-[140px_1fr] items-center gap-4 px-4 py-3', !last && 'border-b border-border')}>
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <span className={cn('text-sm text-foreground', mono ? 'font-mono tabular-nums' : 'font-medium')}>
        {pill ? (
          <span className="pill-neutral">{value}</span>
        ) : (
          <>
            {value}
            {suffix && (
              <span className="ml-1 text-xs text-muted-foreground font-sans font-normal">
                {suffix}
              </span>
            )}
          </>
        )}
      </span>
    </div>
  );
}

interface SettingRowProps {
  icon: React.ReactNode;
  label: string;
  description: string;
  control: React.ReactNode;
}

function SettingRow({ icon, label, description, control }: SettingRowProps) {
  return (
    <div className="grid grid-cols-[40px_1fr_auto] items-center gap-4 px-4 py-4">
      <span className="grid place-items-center size-9 rounded-md bg-secondary text-foreground">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-semibold tracking-tight">{label}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
      </div>
      <div>{control}</div>
    </div>
  );
}

interface ThemeButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

function ThemeButton({ active, onClick, icon, label }: ThemeButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[4px] text-xs font-medium transition-all cursor-pointer',
        active
          ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon} {label}
    </button>
  );
}
