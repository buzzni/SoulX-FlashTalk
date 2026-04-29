/**
 * wizardStore × storageKey scope subscriber.
 *
 * Pins the integration the user actually feels:
 *   - logout (setUserScope(null)) wipes localStorage + sessionStorage
 *     keys so the next user starts blank.
 *   - login (setUserScope('alice')) runs the global → scoped
 *     migration so jack's pre-scoping draft survives the rollout.
 *   - user-to-user transitions reset in-memory state before rehydrate
 *     so user-A's data doesn't bleed into user-B's screen.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setUserScope, storageKey } from '../storageKey';

// IMPORTANT: imported for side effect — wizardStore module init
// registers its subscribeScope callback. Without the import the
// subscriber doesn't exist and these tests would just exercise
// storageKey alone.
import { useWizardStore, __wizardStoreInternals } from '../wizardStore';

beforeEach(() => {
  setUserScope(null);
  localStorage.clear();
  sessionStorage.clear();
  __wizardStoreInternals.reset();
});

afterEach(() => {
  setUserScope(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('logout (setUserScope(null))', () => {
  it('clears localStorage keys owned by the previous user', () => {
    setUserScope('alice');
    localStorage.setItem(storageKey('wizard'), '{"state":{},"version":8}');
    localStorage.setItem(storageKey('step'), '2');
    localStorage.setItem(storageKey('notify.enabled'), 'off');

    setUserScope(null);

    expect(localStorage.getItem('showhost.wizard.v1.alice')).toBeNull();
    expect(localStorage.getItem('showhost.step.v1.alice')).toBeNull();
    expect(localStorage.getItem('showhost.notify.enabled.v1.alice')).toBeNull();
  });

  it('clears sessionStorage dispatch flags', () => {
    setUserScope('alice');
    sessionStorage.setItem(storageKey('justDispatched'), 'task-x');
    sessionStorage.setItem(storageKey('dispatchSnapshot'), '{"taskId":"x"}');

    setUserScope(null);

    expect(sessionStorage.getItem('showhost.justDispatched.v1.alice')).toBeNull();
    expect(sessionStorage.getItem('showhost.dispatchSnapshot.v1.alice')).toBeNull();
  });

  it('drops in-memory store state', () => {
    setUserScope('alice');
    useWizardStore.setState({ playlistId: 'p-123' }, false);
    expect(useWizardStore.getState().playlistId).toBe('p-123');

    setUserScope(null);

    expect(useWizardStore.getState().playlistId).toBeNull();
  });
});

describe('login (setUserScope("alice"))', () => {
  it('moves the legacy global step into the scoped slot', () => {
    // Pre-scoping era leftover: step pointer at global key.
    localStorage.setItem('showhost.step.v1', '3');

    setUserScope('jack');

    // Migrated to scoped key, global slot wiped.
    expect(localStorage.getItem('showhost.step.v1.jack')).toBe('3');
    expect(localStorage.getItem('showhost.step.v1')).toBeNull();
  });

  it('moves the legacy global wizard draft into the scoped slot, then rehydrates', () => {
    // Use a globally valid blob so persist's rehydrate keeps it. (A
    // schema-invalid blob would be caught by migrateWizardEnvelope's
    // safeParse and reset to INITIAL_WIZARD_STATE.) This test just
    // pins the migration step — the global key disappears and the
    // scoped key is non-empty after the scope change.
    const blob = JSON.stringify({
      state: {
        host: { input: { kind: 'text', prompt: '', negativePrompt: '', extraPrompt: '' }, temperature: 0.7, generation: { state: 'idle' } },
        products: [],
        background: { kind: 'preset', presetId: null },
        composition: { settings: { direction: '', shot: 'medium', angle: 'eye', temperature: 0.7, rembg: true }, generation: { state: 'idle' } },
        voice: { source: 'tts', voiceId: null, voiceName: null, advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 }, script: { paragraphs: [''] }, generation: { state: 'idle' } },
        resolution: '448p',
        imageQuality: '1K',
        playlistId: 'legacy-p',
        wizardEpoch: 0,
      },
      version: 8,
    });
    localStorage.setItem('showhost.wizard.v1', blob);

    setUserScope('jack');

    // Scoped key now has data — store rehydrate persisted whatever
    // shape it ends up with (byte-equal to blob isn't guaranteed
    // because rehydrate writes a partialized projection).
    expect(localStorage.getItem('showhost.wizard.v1.jack')).not.toBeNull();
    // Global slot is wiped — can't be inherited by future users.
    expect(localStorage.getItem('showhost.wizard.v1')).toBeNull();
  });

  it('does not overwrite an existing scoped draft with the global one', () => {
    // Scoped slot already has jack's data; the global slot has stale
    // pre-rollout data from someone else. Migration should leave the
    // scoped slot alone and just wipe the global.
    const scopedBlob = JSON.stringify({
      state: {
        host: { input: { kind: 'text', prompt: 'scoped', negativePrompt: '', extraPrompt: '' }, temperature: 0.7, generation: { state: 'idle' } },
        products: [],
        background: { kind: 'preset', presetId: null },
        composition: { settings: { direction: '', shot: 'medium', angle: 'eye', temperature: 0.7, rembg: true }, generation: { state: 'idle' } },
        voice: { source: 'tts', voiceId: null, voiceName: null, advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 }, script: { paragraphs: [''] }, generation: { state: 'idle' } },
        resolution: '448p',
        imageQuality: '1K',
        playlistId: 'scoped-p',
        wizardEpoch: 0,
      },
      version: 8,
    });
    const globalBlob = '{"state":{"playlistId":"global-p"},"version":8}';
    localStorage.setItem('showhost.wizard.v1.jack', scopedBlob);
    localStorage.setItem('showhost.wizard.v1', globalBlob);

    setUserScope('jack');

    // The migration must NOT clobber an existing scoped slot.
    // After rehydrate runs the scoped slot may be re-serialized
    // (partialize round-trip) but the playlistId from scoped is what
    // the store ends up with.
    expect(useWizardStore.getState().playlistId).toBe('scoped-p');
    expect(localStorage.getItem('showhost.wizard.v1')).toBeNull();
  });
});

describe('user-to-user transition', () => {
  it('resets in-memory state when scope changes between two non-null users', () => {
    setUserScope('alice');
    useWizardStore.setState({ playlistId: 'alice-p' }, false);
    expect(useWizardStore.getState().playlistId).toBe('alice-p');

    setUserScope('bob');

    // bob's scope hydrate from empty storage → INITIAL_WIZARD_STATE.
    // alice's playlistId must NOT bleed through.
    expect(useWizardStore.getState().playlistId).toBeNull();
  });
});
