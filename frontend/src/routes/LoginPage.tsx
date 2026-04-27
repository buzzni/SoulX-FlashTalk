/**
 * /login — credential page.
 *
 * Korean Productivity 결: 워크스페이스 마크 + 큰 Pretendard 700 헤딩
 * + 부드러운 카드. AppLayout 안 씀 (사이드바 X — 로그인 전 상태).
 */
import { FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { humanizeError } from '../api/http';
import { login } from '../stores/authStore';
import { Brand } from '../components/brand';

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
    <div className="min-h-screen flex items-center justify-center bg-background px-5 py-10">
      <div className="w-full max-w-sm animate-rise">
        {/* Workspace mark — centered hero */}
        <div className="mb-8 flex justify-center">
          <Brand size="lg" />
        </div>

        <h1 id="login-heading" className="headline-section m-0 mb-2 text-center">
          다시 만나요.
        </h1>
        <p className="m-0 mb-7 text-[14px] text-ink-2 text-center">
          작업실에 들어오려면 로그인이 필요해요.
        </p>

        <form
          onSubmit={onSubmit}
          aria-labelledby="login-heading"
          className="surface-card p-5 flex flex-col gap-4"
        >
          <Field label="아이디" htmlFor="login-userid">
            <input
              id="login-userid"
              type="text"
              autoComplete="username"
              autoFocus
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={busy}
              className="h-10 px-3 text-[14px] rounded-md border border-input bg-background disabled:opacity-60 transition-[border-color,box-shadow] focus:border-primary focus:outline-none focus:shadow-[0_0_0_3px_var(--primary-soft)]"
            />
          </Field>

          <Field label="비밀번호" htmlFor="login-password">
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              className="h-10 px-3 text-[14px] rounded-md border border-input bg-background disabled:opacity-60 transition-[border-color,box-shadow] focus:border-primary focus:outline-none focus:shadow-[0_0_0_3px_var(--primary-soft)]"
            />
          </Field>

          {error && (
            <div
              role="alert"
              className="px-3 py-2 text-[12.5px] rounded-md border bg-destructive-soft text-destructive border-destructive/30"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="h-11 px-4 text-[14px] font-bold rounded-md bg-primary text-primary-foreground hover:bg-[var(--primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed transition-colors mt-1"
          >
            {busy ? '확인 중…' : '들어가기'}
          </button>
        </form>

        <p className="mt-5 text-[12px] text-muted-foreground text-center">
          처음 오셨나요? 관리자에게 계정을 요청하세요.
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-semibold text-foreground">{label}</span>
      {children}
    </label>
  );
}
