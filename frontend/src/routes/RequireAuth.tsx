/**
 * RequireAuth — wraps protected routes. Redirects to /login if no token.
 *
 * Note: this is the cheap client-side guard. The backend middleware is
 * the real gate; this just avoids an unnecessary 401 round-trip and keeps
 * the URL honest after a token expiry.
 */
import { Navigate, useLocation } from 'react-router-dom';
import { isAuthenticated } from '../stores/authStore';

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!isAuthenticated()) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <>{children}</>;
}
