/**
 * storageKey — central factory for localStorage / sessionStorage keys
 * used by the studio. Extends keys with the current user's id so two
 * users on the same device don't share wizard drafts, dispatch flags,
 * or notification preferences.
 *
 * Lifecycle:
 *  - authStore calls `setUserScope(user.user_id)` after login / restore.
 *  - authStore calls `setUserScope(null)` on logout / 401.
 *  - Subscribers (wizardStore most importantly) re-bind their persist
 *    storage and rehydrate when the scope changes.
 *
 * Without this scoping the keys are global ('showhost.wizard.v1' etc.),
 * which is how user-A's draft used to surface in user-B's home page.
 */

const NAMESPACE = 'showhost';
const VERSION = 'v1';

let userScope: string | null = null;
const scopeListeners = new Set<(next: string | null, prev: string | null) => void>();

/**
 * Set the user-scope suffix. Calls subscribers synchronously so they
 * can re-bind storage before any subsequent storageKey() reads.
 *
 * Pass `null` on logout — that drives subscribers (wizardStore) to
 * reset to the initial state. Without that, in-memory store state
 * from the previous user lingers across logins.
 *
 * Subscribers receive both the new and previous scope so logout
 * cleanup can resolve keys against the user that just left.
 */
export function setUserScope(userId: string | null | undefined): void {
  const next = userId && typeof userId === 'string' ? userId : null;
  if (next === userScope) return;
  const prev = userScope;
  userScope = next;
  scopeListeners.forEach((fn) => {
    try { fn(next, prev); } catch { /* keep going */ }
  });
}

export function getUserScope(): string | null {
  return userScope;
}

/**
 * Subscribe to userScope changes. Returns an unsubscribe function.
 * wizardStore uses this to re-bind its persist `name` and rehydrate
 * without depending on authStore directly (avoiding an import cycle
 * that would let wizardStore evaluate before scope is applied).
 *
 * Callback receives (next, prev) so logout cleanup can resolve keys
 * for the user that just left.
 */
export function subscribeScope(
  fn: (next: string | null, prev: string | null) => void,
): () => void {
  scopeListeners.add(fn);
  return () => {
    scopeListeners.delete(fn);
  };
}

/**
 * Compose a versioned, optionally user-scoped storage key.
 *
 *   storageKey('wizard')               // → 'showhost.wizard.v1'
 *   storageKey('wizard')               (scope='42') // → 'showhost.wizard.v1.42'
 *   storageKey('wizard', 'alice')      // → 'showhost.wizard.v1.alice'
 *
 * The optional `scopeOverride` argument is for cleanup paths that
 * need to resolve keys for a scope other than the current one
 * (e.g. wizardStore's logout subscriber wiping the prev user's keys).
 */
export function storageKey(suffix: string, scopeOverride?: string | null): string {
  const base = `${NAMESPACE}.${suffix}.${VERSION}`;
  const effective = scopeOverride === undefined ? userScope : scopeOverride;
  return effective ? `${base}.${effective}` : base;
}

// Keys that live in localStorage. Extended on logout cleanup.
const LOCAL_SUFFIXES = ['wizard', 'step', 'notify.enabled'] as const;
// Keys that live in sessionStorage (dispatch flags). Same scope, different jar.
const SESSION_SUFFIXES = ['justDispatched', 'dispatchSnapshot', 'dispatchInflight'] as const;
// Legacy keys — kept here so the ErrorBoundary "reset state" button
// and logout cleanup also clear them. Pre-storageKey writes that
// post-refactor code never produces but old user installs may have.
const LEGACY_KEYS = ['showhost_state', 'showhost_step', 'showhost.wizard.v1', 'showhost.step.v1'];

/** localStorage keys for a given user scope (defaults to current).
 * Includes legacy / pre-scoping global keys so post-rollout cleanup
 * also wipes them — once any user has owned this device, the global
 * slot is dead. */
export function localStorageKeys(scopeOverride?: string | null): string[] {
  return [
    ...LOCAL_SUFFIXES.map((s) => storageKey(s, scopeOverride)),
    ...LEGACY_KEYS,
  ];
}

/** sessionStorage keys for a given user scope (defaults to current). */
export function sessionStorageKeys(scopeOverride?: string | null): string[] {
  return SESSION_SUFFIXES.map((s) => storageKey(s, scopeOverride));
}

/** Enumerate every storage key this app has ever written or might
 * write for the current (or supplied) user scope. Combines local +
 * session + legacy. */
export function allOwnedStorageKeys(scopeOverride?: string | null): string[] {
  return [...localStorageKeys(scopeOverride), ...sessionStorageKeys(scopeOverride)];
}
