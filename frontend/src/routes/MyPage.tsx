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
    <div style={pageStyle}>
      <AppHeader />
      <main style={mainStyle}>
        <div style={cardStyle}>
          <h1 style={titleStyle}>마이페이지</h1>

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

          <div style={{ height: 24 }} />
          <button
            type="button"
            onClick={onLogout}
            disabled={busy}
            style={logoutBtnStyle}
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
    <div style={rowStyle}>
      <span style={rowLabelStyle}>{label}</span>
      <span style={rowValueStyle}>{value}</span>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  background: '#f7f7fa',
  display: 'flex',
  flexDirection: 'column',
};

const mainStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  justifyContent: 'center',
  padding: 24,
};

const cardStyle: React.CSSProperties = {
  width: 480,
  maxWidth: '100%',
  background: '#fff',
  borderRadius: 12,
  padding: 32,
  boxShadow: '0 2px 12px rgba(0,0,0,0.05)',
  alignSelf: 'flex-start',
  marginTop: 32,
};

const titleStyle: React.CSSProperties = {
  margin: '0 0 24px',
  fontSize: 22,
  fontWeight: 700,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  padding: '12px 0',
  borderBottom: '1px solid #eef',
  fontSize: 14,
};

const rowLabelStyle: React.CSSProperties = { color: '#666' };
const rowValueStyle: React.CSSProperties = { fontWeight: 500 };

const logoutBtnStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 16px',
  background: '#fff',
  color: '#b00020',
  border: '1px solid #b00020',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
};
