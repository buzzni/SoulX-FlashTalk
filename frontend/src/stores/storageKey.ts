/**
 * storageKey — central factory for localStorage keys used by Zustand
 * `persist` middleware (and direct callers, e.g. ErrorBoundary's
 * "clear state" escape hatch).
 *
 * E3 (from REFACTOR_PLAN.md §Decisions #11): lays the path to user-
 * scoped storage. Today it returns a global key. When the real
 * authStore lands, `setUserScope(userId)` makes every subsequent
 * `storageKey('wizard')` return `'showhost.wizard.v1.{userId}'` — no
 * per-store migration, no plumbing through every call site.
 *
 * Rules:
 * - Never hard-code `localStorage.setItem('showhost_…')` elsewhere.
 *   Everything goes through `storageKey()` (or a helper that does).
 * - Version suffix (`v1`) isolates post-refactor state from the
 *   legacy `showhost_state` payload. The migration hook in
 *   wizardStore.ts reads the legacy key once, transforms, writes
 *   under the new key, and deletes the old.
 */

const NAMESPACE = 'showhost';
const VERSION = 'v1';

let userScope: string | null = null;

/**
 * Set the user-scope suffix. Called by authStore on login (and
 * cleared to `null` on logout). No-op today — the auth slot (E1 +
 * E2) lands after Phase 5.
 */
export function setUserScope(userId: string | null | undefined): void {
  userScope = userId && typeof userId === 'string' ? userId : null;
}

export function getUserScope(): string | null {
  return userScope;
}

/**
 * Compose a versioned, optionally user-scoped localStorage key.
 *
 *   storageKey('wizard')               // → 'showhost.wizard.v1'
 *   storageKey('wizard')   (scoped=42) // → 'showhost.wizard.v1.42'
 */
export function storageKey(suffix: string): string {
  const base = `${NAMESPACE}.${suffix}.${VERSION}`;
  return userScope ? `${base}.${userScope}` : base;
}

/** Enumerate every storage key this app has ever written or might
 * write for the current user scope — used by ErrorBoundary's "reset
 * state" button and by any future "sign out" cleanup. Additive: new
 * stores should add their suffix here. */
export function allOwnedStorageKeys(): string[] {
  return [
    storageKey('wizard'),
    storageKey('step'),
    // Legacy keys kept for the ErrorBoundary escape hatch — clearing
    // them on "reset" protects users who upgrade mid-session and hit
    // a persisted-state bug from either era.
    'showhost_state',
    'showhost_step',
  ];
}
