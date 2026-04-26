/**
 * Lane B.5 (D11) — wizardStore shape reconciliation tests.
 *
 * Verifies the v7 → v8 migrate path:
 *   - hoists stray `playlist_id` (snake_case, written via the now-
 *     removed [k:string]:unknown escape hatch) into the typed top-level
 *     `playlistId`.
 *   - drops the dead top-level `script: string` (voice owns the script
 *     via `voice.script.paragraphs[]`).
 *   - prefers an existing camelCase `playlistId` if both keys exist.
 *
 * Tested directly against `migrateWizardEnvelope` rather than via the
 * persist round-trip — module-level persist hydration runs once per
 * import and resists reset.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { migrateWizardEnvelope } from '../wizardStore';

const v7Base = {
  host: { input: { kind: 'text', prompt: '', builder: {}, negativePrompt: '', extraPrompt: '' }, temperature: 0.7, generation: { state: 'idle' } },
  products: [],
  background: { kind: 'preset', presetId: null },
  composition: { settings: { direction: '', shot: 'medium', angle: 'eye', temperature: 0.7, rembg: true }, generation: { state: 'idle' } },
  voice: { source: 'tts', voiceId: null, voiceName: null, advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 }, script: { paragraphs: [''] }, generation: { state: 'idle' } },
  resolution: '448p',
  imageQuality: '1K',
  wizardEpoch: 0,
};

describe('migrateWizardEnvelope — v7 → v8', () => {
  it('hoists snake_case playlist_id into top-level playlistId', () => {
    const before = { ...v7Base, script: 'dead-legacy', playlist_id: 'pl-001' };
    const after = migrateWizardEnvelope(before, 7) as Record<string, unknown>;
    expect(after.playlistId).toBe('pl-001');
    expect(after.playlist_id).toBeUndefined();
    expect(after.script).toBeUndefined();
  });

  it('keeps camelCase playlistId when both keys exist', () => {
    const before = { ...v7Base, playlist_id: 'losing-snake', playlistId: 'winning-camel' };
    const after = migrateWizardEnvelope(before, 7) as Record<string, unknown>;
    expect(after.playlistId).toBe('winning-camel');
  });

  it('null-safe when no playlist field exists', () => {
    const after = migrateWizardEnvelope({ ...v7Base }, 7) as Record<string, unknown>;
    expect(after.playlistId).toBeUndefined();
  });

  it('drops dead top-level script even when playlist_id is absent', () => {
    const before = { ...v7Base, script: 'should-be-gone' };
    const after = migrateWizardEnvelope(before, 7) as Record<string, unknown>;
    expect(after.script).toBeUndefined();
  });

  it('passes already-v8 envelopes through unchanged', () => {
    const before = { ...v7Base, playlistId: 'pl-009' };
    const after = migrateWizardEnvelope(before, 8) as Record<string, unknown>;
    expect(after.playlistId).toBe('pl-009');
    expect(after.script).toBeUndefined();
  });
});

describe('migrateWizardEnvelope — older shapes still compose', () => {
  it('runs every version step from v1 → v8 without throwing', () => {
    const veryLegacy = {
      // pre-v2 background flat shape
      background: { source: 'preset', preset: { id: 'sunset' } },
      // top-level `script` from a pre-Voice-tagged-union build
      script: 'old script',
      // and a stray snake_case playlist field
      playlist_id: 'pl-legacy',
    };
    const after = migrateWizardEnvelope(veryLegacy, 1) as Record<string, unknown>;
    expect(after.script).toBeUndefined();
    expect(after.playlistId).toBe('pl-legacy');
    expect((after.background as { kind?: string }).kind).toBe('preset');
  });
});
