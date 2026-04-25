/**
 * /login — minimal credential page (PR2).
 *
 * Separate route (not a modal) so the auth boundary is unambiguous: any
 * unauthenticated request bounces here, the URL says /login, and refresh
 * doesn't lose state. After a successful login we redirect to the
 * `?next=` query param, defaulting to `/`.
 */
import { FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { humanizeError } from '../api/http';
import { login } from '../stores/authStore';

export default function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') || '/';

  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!userId || !password) {
      setError('아이디와 비밀번호를 입력해주세요.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await login(userId.trim(), password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={containerStyle}>
      <form onSubmit={onSubmit} style={formStyle} aria-labelledby="login-heading">
        <h1 id="login-heading" style={titleStyle}>SoulX-FlashTalk Studio</h1>
        <p style={subtitleStyle}>로그인이 필요합니다</p>

        <label style={labelStyle}>
          <span>아이디</span>
          <input
            type="text"
            autoComplete="username"
            autoFocus
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            disabled={busy}
            style={inputStyle}
          />
        </label>

        <label style={labelStyle}>
          <span>비밀번호</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            style={inputStyle}
          />
        </label>

        {error && <div role="alert" style={errorStyle}>{error}</div>}

        <button type="submit" disabled={busy} style={buttonStyle}>
          {busy ? '확인 중…' : '로그인'}
        </button>
      </form>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#f7f7fa',
};

const formStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  width: 360,
  padding: 32,
  background: '#fff',
  borderRadius: 12,
  boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
};

const titleStyle: React.CSSProperties = { margin: 0, fontSize: 22, fontWeight: 700 };
const subtitleStyle: React.CSSProperties = { margin: 0, color: '#666', fontSize: 14 };

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 13,
  color: '#333',
};

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  fontSize: 14,
  border: '1px solid #d0d0d6',
  borderRadius: 8,
  outline: 'none',
};

const errorStyle: React.CSSProperties = {
  padding: '8px 12px',
  background: '#fff1f1',
  color: '#b00020',
  borderRadius: 6,
  fontSize: 13,
};

const buttonStyle: React.CSSProperties = {
  padding: '12px 16px',
  fontSize: 14,
  fontWeight: 600,
  background: '#3553ff',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
};
