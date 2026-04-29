/**
 * theme — light/dark mode toggle stored in localStorage.
 *
 * Defaults to light on first visit; user choice persists. Uses a tiny
 * external store pattern so any component can `useSyncExternalStore`-subscribe
 * to changes.
 */

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'showhost.theme.v1';

function readInitial(): Theme {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* ignore */
  }
  return 'light';
}

let current: Theme = readInitial();
const listeners = new Set<() => void>();

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

// Apply initial theme on module load (runs once at bundle init)
if (typeof document !== 'undefined') {
  apply(current);
}

export function getTheme(): Theme {
  return current;
}

export function setTheme(next: Theme): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  apply(next);
  listeners.forEach((fn) => fn());
}

export function toggleTheme(): void {
  setTheme(current === 'dark' ? 'light' : 'dark');
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
