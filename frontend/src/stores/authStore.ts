/**
 * authStore — studio JWT in localStorage + auth-header provider for http.ts.
 *
 * On import:
 *  - reads any persisted token from localStorage
 *  - registers an auth-header provider with http.ts so every fetchJSON
 *    automatically gains `Authorization: Bearer <token>`.
 *  - registers a global `unauthorized` handler that clears the token and
 *    redirects the SPA to /login when a request returns 401/403.
 *
 * No external state library — a tiny event-emitter is enough.
 */

import { fetchJSON, setAuthProvider, setUnauthorizedHandler } from '../api/http';

const TOKEN_KEY = 'studio.jwt.access';
const USER_KEY = 'studio.jwt.user';

export interface AuthUser {
  user_id: string;
  display_name: string;
  role: string;
  subscriptions: string[];
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: AuthUser;
}

let _token: string | null = null;
let _user: AuthUser | null = null;
const _listeners = new Set<() => void>();

function _notify(): void {
  _listeners.forEach((fn) => {
    try { fn(); } catch { /* keep going */ }
  });
}

function _persist(): void {
  if (_token) {
    localStorage.setItem(TOKEN_KEY, _token);
    if (_user) localStorage.setItem(USER_KEY, JSON.stringify(_user));
  } else {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
}

function _restore(): void {
  try {
    _token = localStorage.getItem(TOKEN_KEY);
    const rawUser = localStorage.getItem(USER_KEY);
    _user = rawUser ? (JSON.parse(rawUser) as AuthUser) : null;
  } catch {
    _token = null;
    _user = null;
  }
}

_restore();

setAuthProvider((): Record<string, string> => {
  return _token ? { Authorization: `Bearer ${_token}` } : {};
});

setUnauthorizedHandler(() => {
  // Avoid redirect loop on the login page itself.
  if (window.location.pathname === '/login') return;
  _token = null;
  _user = null;
  _persist();
  _notify();
  // Preserve where the user was so we can bounce back after re-login.
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/login?next=${next}`;
});

export function getToken(): string | null { return _token; }
export function getUser(): AuthUser | null { return _user; }
export function isAuthenticated(): boolean { return _token !== null; }

export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

export async function login(user_id: string, password: string): Promise<AuthUser> {
  const res = await fetchJSON<LoginResponse>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id, password }),
    label: '로그인',
  });
  _token = res.access_token;
  _user = res.user;
  _persist();
  _notify();
  return res.user;
}

export async function logout(): Promise<void> {
  if (!_token) return;
  try {
    await fetchJSON('/api/auth/logout', { method: 'POST', label: '로그아웃' });
  } catch {
    // Even if the server call fails, drop local state.
  }
  _token = null;
  _user = null;
  _persist();
  _notify();
}

export async function fetchMe(): Promise<AuthUser> {
  const me = await fetchJSON<AuthUser>('/api/auth/me', { label: '인증 확인' });
  _user = me;
  _persist();
  _notify();
  return me;
}
