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
    <div className="min-h-screen flex items-center justify-center bg-secondary px-4">
      <form
        onSubmit={onSubmit}
        aria-labelledby="login-heading"
        className="w-full max-w-sm flex flex-col gap-4 p-8 rounded-lg surface-base shadow-[0_4px_24px_rgba(0,0,0,0.06)] animate-fade-in"
      >
        <div className="flex flex-col gap-1">
          <h1 id="login-heading" className="text-xl font-bold tracking-tight">
            SoulX-FlashTalk Studio
          </h1>
          <p className="text-sm text-muted-foreground">로그인이 필요합니다</p>
        </div>

        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium">아이디</span>
          <input
            type="text"
            autoComplete="username"
            autoFocus
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            disabled={busy}
            className="px-3 py-2.5 text-sm rounded-md border border-input bg-card disabled:opacity-60 transition-colors focus:border-primary"
          />
        </label>

        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium">비밀번호</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            className="px-3 py-2.5 text-sm rounded-md border border-input bg-card disabled:opacity-60 transition-colors focus:border-primary"
          />
        </label>

        {error && (
          <div
            role="alert"
            className="px-3 py-2 text-[13px] rounded-md border bg-[hsl(0_90%_96%)] text-destructive border-destructive/30"
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="px-4 py-3 text-sm font-semibold rounded-md bg-primary text-primary-foreground transition-colors hover:bg-[var(--color-brand-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {busy ? '확인 중…' : '로그인'}
        </button>
      </form>
    </div>
  );
}
