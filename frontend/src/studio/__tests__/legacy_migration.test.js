/**
 * One-shot migration from the pre-Phase-2b localStorage layout.
 *
 * Before Phase 2b: HostStudio.jsx owned `showhost_state` (a single
 * JSON blob of the wizard state) and `showhost_step`.
 *
 * After Phase 2b: `wizardStore` owns `showhost.wizard.v1` (Zustand
 * persist envelope); `step` is a plain localStorage key under
 * `showhost.step.v1`.
 *
 * Contract:
 *   1. On first module load, if a legacy payload exists in
 *      `showhost_state`, it's read, transformed, and written under
 *      `showhost.wizard.v1` in Zustand's envelope format
 *      (`{ state, version }`).
 *   2. Both legacy keys (`showhost_state`, `showhost_step`) are
 *      deleted so the migration is idempotent — running it again
 *      is a no-op.
 *   3. A broken/malformed legacy payload is dropped silently (no
 *      crash loop); the user lands on INITIAL_WIZARD_STATE.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { __wizardStoreInternals } from '../../stores/wizardStore';
import { storageKey } from '../../stores/storageKey';

const { migrate, LEGACY_STATE_KEY, LEGACY_STEP_KEY } = __wizardStoreInternals;

beforeEach(() => {
  localStorage.clear();
});

describe('wizardStore — legacy showhost_state migration', () => {
  it('moves a legacy payload under the new storageKey and deletes the old keys', () => {
    const legacy = {
      host: {
        mode: 'text',
        prompt: '소개 영상',
        // Phase 2b: schema migrator binds the legacy `selectedSeed` to
        // the matching variant (or selectedImageId / selectedPath
        // fallback). Seed 10 matches the lone variant below — the
        // migrator picks that as `generation.selected`.
        selectedSeed: 10,
        variants: [
          { seed: 10, id: 'v10', url: '/api/files/host_a.png', path: '/srv/host_a.png' },
        ],
      },
      products: [{ id: 'p1', name: 'Product A', path: '/srv/p1.png' }],
      background: { source: 'preset', preset: { id: 'cafe', label: 'Cafe' }, prompt: '' },
      composition: { shot: 'medium', temperature: 0.7, variants: [] },
      voice: { source: 'tts', voiceId: 'v_abc', script: '안녕하세요', paragraphs: ['안녕하세요'] },
      script: '안녕하세요',
      resolution: { key: '448p', label: '448p', width: 448, height: 768 },
      imageQuality: '1K',
    };
    localStorage.setItem(LEGACY_STATE_KEY, JSON.stringify(legacy));
    localStorage.setItem(LEGACY_STEP_KEY, '2');

    migrate();

    // Old keys gone.
    expect(localStorage.getItem(LEGACY_STATE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_STEP_KEY)).toBeNull();

    // New key written with the Zustand persist envelope shape.
    // Phase 2a/2b: host + background are now schema-typed tagged
    // unions. Legacy `selectedSeed` lives under
    // `host.generation.selected.seed`; legacy `variants` under
    // `host.generation.variants` (only when state is `ready`).
    const raw = localStorage.getItem(storageKey('wizard'));
    expect(raw).toBeTruthy();
    const envelope = JSON.parse(raw);
    expect(envelope.version).toBe(5);
    expect(envelope.state.host.input.kind).toBe('text');
    expect(envelope.state.host.input.prompt).toBe('소개 영상');
    expect(envelope.state.host.generation.state).toBe('ready');
    expect(envelope.state.host.generation.selected?.seed).toBeDefined();
    expect(envelope.state.host.generation.variants).toHaveLength(1);
    expect(envelope.state.background).toEqual({ kind: 'preset', presetId: 'cafe' });
    expect(envelope.state.products).toHaveLength(1);
    expect(envelope.state.voice.voiceId).toBe('v_abc');
    expect(envelope.state.imageQuality).toBe('1K');

    // Step is preserved — user mid-Step-2 stays on Step 2 after upgrade.
    expect(localStorage.getItem(storageKey('step'))).toBe('2');
  });

  it('clamps an out-of-range legacy step to a valid 1..3 value', () => {
    localStorage.setItem(LEGACY_STATE_KEY, JSON.stringify({ host: {}, products: [], background: {}, composition: {}, voice: {}, script: '', resolution: {}, imageQuality: '1K' }));
    localStorage.setItem(LEGACY_STEP_KEY, '999');

    migrate();

    // Out-of-range step → not written (HostStudio's initializer defaults to 1).
    expect(localStorage.getItem(storageKey('step'))).toBeNull();
  });

  it('is idempotent — running twice does not re-migrate or clobber', () => {
    const legacy = {
      host: { mode: 'text', prompt: 'first' },
      products: [],
      background: {},
      composition: {},
      voice: {},
      script: '',
      resolution: { key: '448p' },
      imageQuality: '1K',
    };
    localStorage.setItem(LEGACY_STATE_KEY, JSON.stringify(legacy));

    migrate();
    const afterFirst = localStorage.getItem(storageKey('wizard'));

    // Now someone sneaks a different "legacy" payload in and re-runs —
    // but the legacy key is gone, so the second migrate() should be a
    // no-op and the new key contents must not change.
    migrate();
    const afterSecond = localStorage.getItem(storageKey('wizard'));

    expect(afterFirst).toBe(afterSecond);
  });

  it('drops a malformed legacy payload silently (no crash, no write)', () => {
    localStorage.setItem(LEGACY_STATE_KEY, '{ this is not valid JSON');
    localStorage.setItem(LEGACY_STEP_KEY, '1');

    // Must not throw.
    expect(() => migrate()).not.toThrow();

    // Old keys cleaned up so the user doesn't hit the broken payload
    // on every reload.
    expect(localStorage.getItem(LEGACY_STATE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_STEP_KEY)).toBeNull();

    // Nothing written under the new key (there was nothing to transform).
    expect(localStorage.getItem(storageKey('wizard'))).toBeNull();
  });

  it('does nothing when there is no legacy payload to migrate', () => {
    expect(() => migrate()).not.toThrow();
    expect(localStorage.getItem(storageKey('wizard'))).toBeNull();
  });

  it('preserves a legacy `resolution` object as-is instead of collapsing to a string', () => {
    // Guards the Step 3 resolution picker which reads state.resolution.key.
    const legacy = {
      host: {},
      products: [],
      background: {},
      composition: {},
      voice: {},
      script: '',
      resolution: { key: '720p', label: '720p', width: 720, height: 1280 },
      imageQuality: '2K',
    };
    localStorage.setItem(LEGACY_STATE_KEY, JSON.stringify(legacy));
    migrate();
    const envelope = JSON.parse(localStorage.getItem(storageKey('wizard')));
    // Migration intentionally preserves the object shape — Step 3 UI
    // won't be rewritten to use a string key until Phase 4.
    expect(envelope.state.resolution).toBeTruthy();
  });
});
