/**
 * /mypage — minimal personal info + logout.
 *
 * Today: greeting, role, subscriptions, total video count, logout button.
 * Tomorrow (deferred): password change, display_name edit, etc.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppHeader } from './AppHeader';
import { fetchJSON } from '../api/http';
import { getUser, logout, subscribe } from '../stores/authStore';

interface HistoryResponse {
  total: number;
  videos: unknown[];
}

export function MyPage() {
  const navigate = useNavigate();
  const user = useSyncExternalStore(subscribe, getUser, getUser);
  const [videoCount, setVideoCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    fetchJSON<HistoryResponse>('/api/history?limit=1000', {
      signal: ctl.signal,
      label: '활동 정보',
    })
      .then((r) => setVideoCount(r.total))
      .catch(() => setVideoCount(null));
    return () => ctl.abort();
  }, []);

  async function onLogout() {
    setBusy(true);
    try {
      await logout();
    } finally {
      navigate('/login', { replace: true });
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-secondary">
      <AppHeader />
      <main className="flex-1 flex justify-center px-6 py-8">
        <div className="w-full max-w-lg mt-8 self-start rounded-xl surface-base p-8 animate-fade-in">
          <h1 className="m-0 mb-6 text-xl font-bold tracking-tight">마이페이지</h1>

          <Row label="아이디" value={user?.user_id || '—'} />
          <Row label="이름" value={user?.display_name || user?.user_id || '—'} />
          <Row label="역할" value={user?.role || '—'} />
          <Row
            label="구독"
            value={(user?.subscriptions || []).join(', ') || '—'}
          />
          <Row
            label="만든 영상"
            value={videoCount === null ? '—' : `${videoCount}개`}
          />

          <button
            type="button"
            onClick={onLogout}
            disabled={busy}
            className="mt-6 w-full px-4 py-3 text-sm font-semibold rounded-md border border-destructive bg-card text-destructive transition-colors hover:bg-destructive hover:text-destructive-foreground disabled:opacity-60 cursor-pointer"
          >
            {busy ? '로그아웃 중…' : '로그아웃'}
          </button>
        </div>
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-3 text-sm border-b border-border last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
