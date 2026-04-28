/**
 * Lane C — persist hydrate validation tests.
 *
 * Drives `migrateWizardEnvelope` directly (already exported for
 * Lane B.5 tests) to verify:
 *   - `WizardStateSerializedSchema.safeParse` is the gate before the
 *     blob reaches React. Corrupted shapes return INITIAL_WIZARD_STATE
 *     instead of crashing a step page.
 *   - 'ready' generation states survive (the selected variant + audio
 *     are reloadable server paths).
 *   - the hydrated blob still passes a follow-up safeParse round-trip.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { migrateWizardEnvelope, INITIAL_WIZARD_STATE } from '../wizardStore';
import { WizardStateSerializedSchema } from '../../wizard/schema';

const v8Valid = {
  host: { input: { kind: 'text', prompt: '', builder: {}, negativePrompt: '', extraPrompt: '' }, temperature: 0.7, generation: { state: 'idle' } },
  products: [],
  background: { kind: 'preset', presetId: null },
  composition: { settings: { direction: '', shot: 'medium', angle: 'eye', temperature: 0.7, rembg: true }, generation: { state: 'idle' } },
  voice: { source: 'tts', voiceId: null, voiceName: null, advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 }, script: { paragraphs: [''] }, generation: { state: 'idle' } },
  resolution: '448p',
  imageQuality: '1K',
  playlistId: null,
  wizardEpoch: 0,
};

describe('Lane C — persist hydrate safeParse gate', () => {
  it('valid v8 blob passes through untouched', () => {
    const out = migrateWizardEnvelope(structuredClone(v8Valid), 8);
    expect(out.resolution).toBe('448p');
    expect(out.playlistId).toBe(null);
  });

  it('corrupted blob (wrong type for resolution) → INITIAL_WIZARD_STATE', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { ...v8Valid, resolution: 99 };
    const out = migrateWizardEnvelope(broken, 8);
    expect(out).toEqual(INITIAL_WIZARD_STATE);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('missing required slice (voice) → INITIAL_WIZARD_STATE', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { ...v8Valid };
    // @ts-expect-error — testing the unhappy path
    delete broken.voice;
    const out = migrateWizardEnvelope(broken, 8);
    expect(out).toEqual(INITIAL_WIZARD_STATE);
    warn.mockRestore();
  });

  it("resets v8 'ready' host generation to idle on migrate to v9", () => {
    // v9 (streaming-resume Phase B): {idle | streaming | ready | failed}
    // collapsed to {idle | attached(jobId)}. Migrating a v8 ready blob
    // resets to idle — the candidates collection on the server retains
    // the actual variant data (eng-spec §7 migration table).
    const blob = {
      ...v8Valid,
      host: {
        input: v8Valid.host.input,
        temperature: 0.7,
        generation: {
          state: 'ready',
          batchId: 'b-001',
          variants: [{ seed: 1, imageId: 'a', url: '/u/a.png', path: '/p/a.png' }],
          selected: { seed: 1, imageId: 'a', url: '/u/a.png', path: '/p/a.png' },
          prevSelected: null,
        },
      },
    };
    const out = migrateWizardEnvelope(blob, 8);
    expect(out.host.generation.state).toBe('idle');
  });

  it('migrated v7 blob with stale streaming voice still parses (scrub happens later via onRehydrateStorage)', () => {
    // Simulate a corrupt-ish v7 carrying generation.state === 'generating'.
    // The migrate fn does not scrub transient states (that is
    // onRehydrateStorage's job once the hydrated blob lands in the
    // store). We just verify the migrate does not reject a structurally
    // valid 'generating' state — the schema permits it.
    const blob = {
      ...v8Valid,
      voice: {
        ...v8Valid.voice,
        generation: { state: 'generating' },
      },
    };
    const out = migrateWizardEnvelope(blob, 8);
    // Voice.upload variant has no `generation`; tts/clone do — gate on
    // the discriminator before reading.
    if (out.voice.source === 'tts' || out.voice.source === 'clone') {
      expect(out.voice.generation.state).toBe('generating');
    } else {
      throw new Error('unexpected voice source after migrate');
    }
  });

  it('round-trips: hydrated state passes the same schema again', () => {
    const out = migrateWizardEnvelope(structuredClone(v8Valid), 8);
    const reparsed = WizardStateSerializedSchema.safeParse(out);
    expect(reparsed.success).toBe(true);
  });
});
