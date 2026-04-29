/**
 * storageKey — userScope contract.
 *
 * Pins the behavior PR1 depends on:
 *   - setUserScope changes storageKey() output
 *   - subscribeScope fires synchronously on changes
 *   - allOwnedStorageKeys() includes both jars (local + session)
 *     and known legacy keys for ErrorBoundary's "reset state"
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  storageKey,
  setUserScope,
  getUserScope,
  subscribeScope,
  localStorageKeys,
  sessionStorageKeys,
  allOwnedStorageKeys,
} from '../storageKey';

beforeEach(() => {
  setUserScope(null);
});

afterEach(() => {
  setUserScope(null);
});

describe('storageKey() output', () => {
  it('returns base key when no scope is set', () => {
    expect(storageKey('wizard')).toBe('showhost.wizard.v1');
  });

  it('appends user_id suffix when scope is set', () => {
    setUserScope('alice');
    expect(storageKey('wizard')).toBe('showhost.wizard.v1.alice');
    expect(storageKey('step')).toBe('showhost.step.v1.alice');
  });

  it('drops the suffix when scope is cleared back to null', () => {
    setUserScope('alice');
    setUserScope(null);
    expect(storageKey('wizard')).toBe('showhost.wizard.v1');
  });

  it('treats empty / non-string user_id as null', () => {
    setUserScope('');
    expect(getUserScope()).toBeNull();
    setUserScope(undefined);
    expect(getUserScope()).toBeNull();
  });
});

describe('subscribeScope', () => {
  it('fires synchronously on each scope change with (next, prev)', () => {
    const fn = vi.fn();
    const unsub = subscribeScope(fn);
    setUserScope('alice');
    setUserScope('bob');
    setUserScope(null);
    expect(fn).toHaveBeenNthCalledWith(1, 'alice', null);
    expect(fn).toHaveBeenNthCalledWith(2, 'bob', 'alice');
    expect(fn).toHaveBeenNthCalledWith(3, null, 'bob');
    unsub();
  });

  it('does NOT fire when the scope value is unchanged', () => {
    setUserScope('alice');
    const fn = vi.fn();
    const unsub = subscribeScope(fn);
    setUserScope('alice');
    expect(fn).not.toHaveBeenCalled();
    unsub();
  });

  it('returned unsubscribe stops further callbacks', () => {
    const fn = vi.fn();
    const unsub = subscribeScope(fn);
    setUserScope('alice');
    unsub();
    setUserScope('bob');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('one subscriber throwing does not break the chain', () => {
    const a = vi.fn(() => { throw new Error('boom'); });
    const b = vi.fn();
    const ua = subscribeScope(a);
    const ub = subscribeScope(b);
    setUserScope('alice');
    expect(b).toHaveBeenCalledWith('alice', null);
    ua();
    ub();
  });
});

describe('owned-key catalogue', () => {
  it('localStorageKeys() includes wizard / step / notify under current scope + legacy', () => {
    setUserScope('jack');
    const keys = localStorageKeys();
    expect(keys).toContain('showhost.wizard.v1.jack');
    expect(keys).toContain('showhost.step.v1.jack');
    expect(keys).toContain('showhost.notify.enabled.v1.jack');
    // legacy / pre-scoping global keys — present so logout cleanup
    // also wipes them from any user installed before user-scoping.
    expect(keys).toContain('showhost_state');
    expect(keys).toContain('showhost.wizard.v1');
    expect(keys).toContain('showhost.step.v1');
  });

  it('sessionStorageKeys() includes the dispatch flags under current scope', () => {
    setUserScope('jack');
    const keys = sessionStorageKeys();
    expect(keys).toContain('showhost.justDispatched.v1.jack');
    expect(keys).toContain('showhost.dispatchSnapshot.v1.jack');
    expect(keys).toContain('showhost.dispatchInflight.v1.jack');
  });

  it('allOwnedStorageKeys() unions both jars', () => {
    setUserScope('jack');
    const all = allOwnedStorageKeys();
    expect(all).toEqual(
      expect.arrayContaining([
        'showhost.wizard.v1.jack',
        'showhost.justDispatched.v1.jack',
        'showhost_state',
      ]),
    );
  });
});
