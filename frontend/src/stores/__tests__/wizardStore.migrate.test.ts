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
    const after = migrateWizardEnvelope(before, 7) as unknown as Record<string, unknown>;
    expect(after.playlistId).toBe('pl-001');
    expect(after.playlist_id).toBeUndefined();
    expect(after.script).toBeUndefined();
  });

  it('keeps camelCase playlistId when both keys exist', () => {
    const before = { ...v7Base, playlist_id: 'losing-snake', playlistId: 'winning-camel' };
    const after = migrateWizardEnvelope(before, 7) as unknown as Record<string, unknown>;
    expect(after.playlistId).toBe('winning-camel');
  });

  it('null-safe when no playlist field exists (Lane C safeParse defaults to null on the typed top-level field)', () => {
    // v7Base doesn't include playlistId; the v8 schema requires it as
    // string|null, so parse normalises a missing-field blob into the
    // initial state where playlistId === null. Important: never
    // `undefined` — components rely on the strict null contract.
    const after = migrateWizardEnvelope({ ...v7Base }, 7) as unknown as Record<string, unknown>;
    expect(after.playlistId).toBe(null);
  });

  it('drops dead top-level script even when playlist_id is absent', () => {
    const before = { ...v7Base, script: 'should-be-gone' };
    const after = migrateWizardEnvelope(before, 7) as unknown as Record<string, unknown>;
    expect(after.script).toBeUndefined();
  });

  it('passes already-v8 envelopes through unchanged', () => {
    const before = { ...v7Base, playlistId: 'pl-009' };
    const after = migrateWizardEnvelope(before, 8) as unknown as Record<string, unknown>;
    expect(after.playlistId).toBe('pl-009');
    expect(after.script).toBeUndefined();
  });
});

describe('migrateWizardEnvelope — v8 → v9 (HostGeneration collapse)', () => {
  // v9 (streaming-resume Phase B): {idle | streaming | ready | failed}
  // collapses to {idle | attached(jobId)}. Persisted v8 streaming/ready/
  // failed rows reset to idle on first hydrate; ready candidates from v8
  // still live in studio_hosts (server-side) and resurface via v2.1's
  // history view (eng-spec §7 migration table).

  const v8Base = {
    ...v7Base,
    playlistId: null,
  };

  it('resets a v8 streaming host.generation to idle', () => {
    const before = {
      ...v8Base,
      host: {
        ...v8Base.host,
        generation: {
          state: 'streaming',
          batchId: 'b1',
          variants: [{ seed: 1, imageId: 'h1', url: '/u/h1.png', path: '/p/h1.png' }],
        },
      },
    };
    const after = migrateWizardEnvelope(before, 8) as unknown as Record<string, unknown>;
    const host = after.host as { generation: { state: string } };
    expect(host.generation.state).toBe('idle');
    expect(Object.keys(host.generation)).toEqual(['state']);  // no leftover variants/batchId
  });

  it('resets a v8 ready host.generation to idle (server keeps the candidates)', () => {
    const before = {
      ...v8Base,
      host: {
        ...v8Base.host,
        generation: {
          state: 'ready',
          batchId: 'b2',
          variants: [{ seed: 1, imageId: 'h1', url: '/u/h1.png', path: '/p/h1.png' }],
          selected: { seed: 1, imageId: 'h1', url: '/u/h1.png', path: '/p/h1.png' },
          prevSelected: null,
        },
      },
    };
    const after = migrateWizardEnvelope(before, 8) as unknown as Record<string, unknown>;
    const host = after.host as { generation: { state: string } };
    expect(host.generation.state).toBe('idle');
  });

  it('resets a v8 failed host.generation to idle', () => {
    const before = {
      ...v8Base,
      host: {
        ...v8Base.host,
        generation: { state: 'failed', error: 'GPU OOM' },
      },
    };
    const after = migrateWizardEnvelope(before, 8) as unknown as Record<string, unknown>;
    const host = after.host as { generation: { state: string } };
    expect(host.generation.state).toBe('idle');
  });

  it('resets composition.generation the same way', () => {
    const before = {
      ...v8Base,
      composition: {
        ...v8Base.composition,
        generation: {
          state: 'streaming',
          batchId: 'cb1',
          variants: [],
        },
      },
    };
    const after = migrateWizardEnvelope(before, 8) as unknown as Record<string, unknown>;
    const comp = after.composition as { generation: { state: string } };
    expect(comp.generation.state).toBe('idle');
  });

  it('passes already-v9 envelopes through (idle stays idle, attached stays attached)', () => {
    const before = {
      ...v8Base,
      host: { ...v8Base.host, generation: { state: 'attached', jobId: 'job-x' } },
    };
    const after = migrateWizardEnvelope(before, 9) as unknown as Record<string, unknown>;
    const host = after.host as { generation: { state: string; jobId?: string } };
    expect(host.generation.state).toBe('attached');
    expect(host.generation.jobId).toBe('job-x');
  });

  // ── Data preservation: eng-spec §7 lift contract ─────────────────
  // v8 carried the user-picked variant under host.generation.selected.
  // v9 collapses generation to {idle | attached(jobId)} and moves the
  // pick to host.selected. The migrate code lifts the snapshot so a
  // user upgrading mid-wizard doesn't lose their pick. These tests
  // pin the lift behavior — without them, a regression silently drops
  // every reload-time selection.

  it('lifts a v8 ready host.generation.selected onto host.selected', () => {
    const picked = { seed: 7, imageId: 'h-pick', url: '/u/h-pick.png', path: '/p/h-pick.png' };
    const before = {
      ...v8Base,
      host: {
        ...v8Base.host,
        generation: {
          state: 'ready',
          batchId: 'b2',
          variants: [picked],
          selected: picked,
          prevSelected: null,
        },
      },
    };
    const after = migrateWizardEnvelope(before, 8) as unknown as Record<string, unknown>;
    const host = after.host as {
      generation: { state: string };
      selected: { imageId: string; path: string; url: string; seed: number } | null;
    };
    expect(host.generation.state).toBe('idle');
    expect(host.selected).toEqual({
      imageId: 'h-pick', path: '/p/h-pick.png', url: '/u/h-pick.png', seed: 7,
    });
  });

  it('lifts a v8 ready composition.generation.selected onto composition.selected', () => {
    const picked = { seed: 3, imageId: 'c-pick', url: '/u/c.png', path: '/p/c.png' };
    const before = {
      ...v8Base,
      composition: {
        ...v8Base.composition,
        generation: {
          state: 'ready',
          batchId: 'cb',
          variants: [picked],
          selected: picked,
          prevSelected: null,
        },
      },
    };
    const after = migrateWizardEnvelope(before, 8) as unknown as Record<string, unknown>;
    const comp = after.composition as {
      generation: { state: string };
      selected: { imageId: string; path: string; url: string; seed: number } | null;
    };
    expect(comp.generation.state).toBe('idle');
    expect(comp.selected).toEqual({
      imageId: 'c-pick', path: '/p/c.png', url: '/u/c.png', seed: 3,
    });
  });

  it('skips the lift when legacy selected is missing path or url', () => {
    // Pre-Lane-D corrupt blobs lacked path/url. The lift guard
    // (host.path && host.url) drops the lift; selected falls back to
    // null so the safeParse gate doesn't reject the whole blob.
    const before = {
      ...v8Base,
      host: {
        ...v8Base.host,
        generation: {
          state: 'ready',
          variants: [],
          selected: { imageId: 'orphan', seed: 1 }, // no path/url
          prevSelected: null,
        },
      },
    };
    const after = migrateWizardEnvelope(before, 8) as unknown as Record<string, unknown>;
    const host = after.host as { selected: unknown };
    expect(host.selected).toBeNull();
  });

  it('defaults host.selected to null when the v8 blob has no selected field at all', () => {
    // Most persisted v8 blobs predate the host.selected schema and hit
    // the `else if (host.selected === undefined)` branch — without the
    // default, safeParse rejects the whole blob and the user lands in
    // INITIAL_WIZARD_STATE on every reload.
    const before = JSON.parse(JSON.stringify(v8Base)); // deep clone, no defaults
    delete before.host.selected;
    const after = migrateWizardEnvelope(before, 8) as unknown as Record<string, unknown>;
    const host = after.host as { selected: unknown };
    expect(host.selected).toBeNull();
  });
});

describe('migrateWizardEnvelope — older shapes still compose', () => {
  it('runs the v1 → v8 chain without throwing on a partial legacy blob', () => {
    const veryLegacy = {
      background: { source: 'preset', preset: { id: 'sunset' } },
      script: 'old script',
      playlist_id: 'pl-legacy',
    };
    // The chain itself does not throw. After Lane C added the
    // safeParse gate, a *partial* legacy blob falls back to
    // INITIAL_WIZARD_STATE because the migration didn't produce
    // every required slice. That is the intended behavior — corrupt
    // data shouldn't reach React.
    expect(() => migrateWizardEnvelope(veryLegacy, 1)).not.toThrow();
  });
});
