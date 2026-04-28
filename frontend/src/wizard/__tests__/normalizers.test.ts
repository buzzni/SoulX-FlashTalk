/**
 * Normalizer + schema tests.
 *
 * Critical path: legacy persisted state (the shape that lived in
 * wizardStore.ts INITIAL_WIZARD_STATE before Phase 1) must migrate
 * into a valid schema state, with no `any` escape hatches.
 *
 * Persistence round-trip: toPersistable must drop File handles + blob
 * URLs but keep server paths. migrateLegacy → toPersistable should
 * be idempotent on the schema-shaped output.
 */

import { describe, expect, it } from 'vitest';
import {
  isBackgroundReady,
  isHostReady,
  isProductReady,
  isVoiceReady,
} from '../schema';
import { migrateImageQuality, migrateLegacy, persistVoice, toPersistable } from '../normalizers';

describe('migrateLegacy', () => {
  it('returns INITIAL_WIZARD_STATE for null/undefined/garbage', () => {
    const a = migrateLegacy(null);
    const b = migrateLegacy(undefined);
    const c = migrateLegacy('a string');
    expect(a.host.input.kind).toBe('text');
    expect(a.background.kind).toBe('preset');
    expect(b.host.input.kind).toBe('text');
    expect(c.background.kind).toBe('preset');
  });

  it('migrates legacy text-mode host with prompt + builder + variants', () => {
    const legacy = {
      host: {
        mode: 'text',
        prompt: '30대 여성, 밝게 웃고 있음',
        builder: { 성별: 'female', 연령대: '30s' },
        negativePrompt: '',
        temperature: 0.65,
        generated: true,
        selectedSeed: 42,
        selectedImageId: 'host_abc_s42',
        variants: [
          { seed: 10, id: 'v10', imageId: 'host_abc_s10', url: 'https://x/10.png', path: 'h/10.png' },
          { seed: 42, id: 'v42', imageId: 'host_abc_s42', url: 'https://x/42.png', path: 'h/42.png' },
        ],
      },
    };
    const out = migrateLegacy(legacy);
    expect(out.host.input.kind).toBe('text');
    if (out.host.input.kind !== 'text') throw new Error('narrowing');
    expect(out.host.input.prompt).toBe('30대 여성, 밝게 웃고 있음');
    expect(out.host.input.builder['성별']).toBe('female');
    expect(out.host.temperature).toBe(0.65);
    // v9 (streaming-resume Phase B): legacy variants/selected drop on
    // migrate — they live in studio_hosts on the server, surfaced via
    // v2.1's history view. Migrated state is always idle.
    expect(out.host.generation.state).toBe('idle');
  });

  it('migrates background by source discriminator', () => {
    expect(migrateLegacy({ background: { source: 'preset', preset: 'studio_white' } }).background).toEqual({
      kind: 'preset',
      presetId: 'studio_white',
    });
    expect(migrateLegacy({ background: { source: 'url', url: 'https://x/y.png' } }).background).toEqual({
      kind: 'url',
      url: 'https://x/y.png',
    });
    expect(migrateLegacy({ background: { source: 'prompt', prompt: '아늑한 거실' } }).background).toEqual({
      kind: 'prompt',
      prompt: '아늑한 거실',
    });
    const upload = migrateLegacy({
      background: { source: 'upload', uploadPath: 'bg/foo.png', imageUrl: 'https://x/foo.png', serverFilename: 'foo.png' },
    }).background;
    expect(upload).toEqual({
      kind: 'upload',
      asset: { path: 'bg/foo.png', url: 'https://x/foo.png', name: 'foo.png' },
    });
  });

  it('drops blob: / data: urls during migration (transient)', () => {
    const out = migrateLegacy({
      background: { source: 'upload', uploadPath: 'bg/foo.png', imageUrl: 'blob:http://localhost/xxx' },
    });
    if (out.background.kind === 'upload' && out.background.asset && 'path' in out.background.asset) {
      expect(out.background.asset.url).toBeUndefined();
      expect(out.background.asset.path).toBe('bg/foo.png');
    } else {
      throw new Error('expected uploaded server asset');
    }
  });

  it('drops legacy _gradient and _file fields (no longer in schema)', () => {
    const out = migrateLegacy({
      background: { source: 'preset', preset: 'living_cozy', _gradient: 'linear-gradient(...)', _file: { fake: 'thing' } },
    });
    expect(out.background).toEqual({ kind: 'preset', presetId: 'living_cozy' });
  });

  it('migrates voice tts source with cloned audio result', () => {
    const out = migrateLegacy({
      voice: {
        source: 'tts',
        voiceId: 'v_minji',
        voiceName: '민지',
        paragraphs: ['안녕하세요'],
        script: '안녕하세요',
        stability: 0.5,
        style: 0.3,
        similarity: 0.75,
        speed: 1.1,
        generated: true,
        generatedAudioPath: 'audio/abc.mp3',
        generatedAudioUrl: 'https://x/abc.mp3',
      },
    });
    expect(out.voice.source).toBe('tts');
    if (out.voice.source !== 'tts') throw new Error('narrowing');
    expect(out.voice.voiceId).toBe('v_minji');
    expect(out.voice.script.paragraphs).toEqual(['안녕하세요']);
    expect(out.voice.advanced.speed).toBe(1.1);
    expect(out.voice.generation.state).toBe('ready');
  });

  it('migrates voice clone source with cloneSample.voiceId', () => {
    const out = migrateLegacy({
      voice: {
        source: 'clone',
        cloneSample: { voiceId: 'cloned_xyz', name: '내 목소리' },
        paragraphs: ['hi'],
      },
    });
    expect(out.voice.source).toBe('clone');
    if (out.voice.source !== 'clone') throw new Error('narrowing');
    expect(out.voice.sample.state).toBe('cloned');
    if (out.voice.sample.state === 'cloned') {
      expect(out.voice.sample.voiceId).toBe('cloned_xyz');
    }
  });

  it('migrates voice upload source with uploadedAudio path', () => {
    const out = migrateLegacy({
      voice: {
        source: 'upload',
        uploadedAudio: { path: 'audio/upload/foo.mp3', name: 'foo.mp3' },
        script: 'subtitle line',
      },
    });
    expect(out.voice.source).toBe('upload');
    if (out.voice.source !== 'upload') throw new Error('narrowing');
    expect(out.voice.audio).toEqual({ path: 'audio/upload/foo.mp3', name: 'foo.mp3' });
  });

  it('falls back to default resolution + imageQuality when missing', () => {
    const out = migrateLegacy({});
    expect(out.resolution).toBe('448p');
    expect(out.imageQuality).toBe('1K');
  });

  it('preserves valid resolution key', () => {
    expect(migrateLegacy({ resolution: { key: '720p' } }).resolution).toBe('720p');
    expect(migrateLegacy({ resolution: { key: '1080p' } }).resolution).toBe('1080p');
    // invalid → default
    expect(migrateLegacy({ resolution: { key: 'foo' } }).resolution).toBe('448p');
  });

  // Backend VALID_SHOTS = {closeup, bust, medium, full}. The frontend used to
  // expose {close, medium, far} — old persisted blobs must map onto the new
  // backend enum so /api/composite/generate doesn't reject the shot.
  // Legacy blobs put `shot` at the composition top level (pre-`settings.` nesting).
  it('migrates legacy composition.shot values onto the backend enum', () => {
    expect(migrateLegacy({ composition: { shot: 'close' } }).composition.settings.shot).toBe('closeup');
    expect(migrateLegacy({ composition: { shot: 'far' } }).composition.settings.shot).toBe('full');
    expect(migrateLegacy({ composition: { shot: 'medium' } }).composition.settings.shot).toBe('medium');
    expect(migrateLegacy({ composition: { shot: 'bust' } }).composition.settings.shot).toBe('bust');
    expect(migrateLegacy({ composition: { shot: 'closeup' } }).composition.settings.shot).toBe('closeup');
    expect(migrateLegacy({ composition: { shot: 'full' } }).composition.settings.shot).toBe('full');
    // Unknown / missing → fall back to medium so the wizard still loads.
    expect(migrateLegacy({ composition: { shot: 'wide' } }).composition.settings.shot).toBe('medium');
    expect(migrateLegacy({ composition: {} }).composition.settings.shot).toBe('medium');
  });
});

describe('migrateImageQuality', () => {
  it('preserves the canonical enum members', () => {
    expect(migrateImageQuality('1K')).toBe('1K');
    expect(migrateImageQuality('2K')).toBe('2K');
    expect(migrateImageQuality('4K')).toBe('4K');
  });
  it('collapses unknown legacy strings to the 1K default', () => {
    expect(migrateImageQuality('HD')).toBe('1K');
    expect(migrateImageQuality('medium')).toBe('1K');
    expect(migrateImageQuality('')).toBe('1K');
  });
  it('coerces non-string values to the 1K default', () => {
    expect(migrateImageQuality(null)).toBe('1K');
    expect(migrateImageQuality(undefined)).toBe('1K');
    expect(migrateImageQuality(123)).toBe('1K');
    expect(migrateImageQuality({})).toBe('1K');
  });
});

describe('toPersistable', () => {
  it('strips local file pending products to empty', () => {
    const out = toPersistable({
      ...migrateLegacy({}),
      products: [
        {
          id: 'p1',
          source: {
            kind: 'localFile',
            asset: {
              file: new File(['a'], 'a.png'),
              previewUrl: 'blob:http://localhost/x',
              name: 'a.png',
            },
          },
        },
        { id: 'p2', source: { kind: 'uploaded', asset: { path: 'p/2.png' } } },
      ],
    });
    expect(out.products[0]?.source.kind).toBe('empty');
    expect(out.products[1]?.source.kind).toBe('uploaded');
  });

  it('preserves attached(jobId) generation state on persist (v9)', () => {
    // v9 collapsed the lifecycle into {idle | attached(jobId)}. Both
    // round-trip through persist unchanged — there's no transient state
    // to scrub anymore. Server-side jobs survive reload via their jobId.
    const out = toPersistable({
      ...migrateLegacy({}),
      host: {
        ...migrateLegacy({}).host,
        generation: { state: 'attached', jobId: 'job-abc' },
      },
    });
    expect(out.host.generation.state).toBe('attached');
    if (out.host.generation.state === 'attached') {
      expect(out.host.generation.jobId).toBe('job-abc');
    }
  });

  it('drops generating/failed voice generation states to idle (tts)', () => {
    const out = persistVoice({
      source: 'tts',
      voiceId: 'v',
      voiceName: 'V',
      advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 },
      script: { paragraphs: ['hi'] },
      generation: { state: 'generating' },
    });
    if (out.source !== 'tts') throw new Error('narrowing');
    expect(out.generation.state).toBe('idle');
  });

  it('keeps ready voice generation across reloads (tts)', () => {
    const out = persistVoice({
      source: 'tts',
      voiceId: 'v',
      voiceName: 'V',
      advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 },
      script: { paragraphs: ['hi'] },
      generation: { state: 'ready', audio: { path: 'a/b.wav' } },
    });
    if (out.source !== 'tts') throw new Error('narrowing');
    expect(out.generation.state).toBe('ready');
    if (out.generation.state === 'ready') {
      expect(out.generation.audio.path).toBe('a/b.wav');
    }
  });

  it('drops pending clone samples to empty (the staged File cannot reload)', () => {
    const file = new File(['fake'], 'sample.wav');
    const out = persistVoice({
      source: 'clone',
      sample: { state: 'pending', asset: { file, previewUrl: 'blob:x', name: 'sample.wav' } },
      advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 },
      script: { paragraphs: ['hi'] },
      generation: { state: 'idle' },
    });
    if (out.source !== 'clone') throw new Error('narrowing');
    expect(out.sample.state).toBe('empty');
  });

  it('keeps cloned clone samples across reloads', () => {
    const out = persistVoice({
      source: 'clone',
      sample: { state: 'cloned', voiceId: 'cv_xyz', name: '내 목소리' },
      advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 },
      script: { paragraphs: ['hi'] },
      generation: { state: 'idle' },
    });
    if (out.source !== 'clone') throw new Error('narrowing');
    expect(out.sample.state).toBe('cloned');
  });

  it('drops LocalAsset audio uploads (only ServerAsset survives)', () => {
    const file = new File(['fake'], 'audio.mp3');
    const out = persistVoice({
      source: 'upload',
      audio: { file, previewUrl: 'blob:y', name: 'audio.mp3' },
      script: { paragraphs: ['caption'] },
    });
    if (out.source !== 'upload') throw new Error('narrowing');
    expect(out.audio).toBeNull();
  });

  it('keeps idle generation state on persist (v9)', () => {
    // v9 collapsed 'ready' into the server-side generation_jobs row.
    // The schema only sees idle | attached(jobId); both round-trip
    // unchanged through toPersistable.
    const out = toPersistable({
      ...migrateLegacy({}),
      host: {
        ...migrateLegacy({}).host,
        generation: { state: 'idle' },
      },
    });
    expect(out.host.generation.state).toBe('idle');
  });
});

describe('readiness predicates', () => {
  it('isBackgroundReady covers all 4 sub-modes', () => {
    expect(isBackgroundReady({ kind: 'preset', presetId: null })).toBe(false);
    expect(isBackgroundReady({ kind: 'preset', presetId: 'studio_white' })).toBe(true);
    expect(isBackgroundReady({ kind: 'upload', asset: null })).toBe(false);
    expect(isBackgroundReady({ kind: 'upload', asset: { path: 'a' } })).toBe(true);
    expect(isBackgroundReady({ kind: 'url', url: '' })).toBe(false);
    expect(isBackgroundReady({ kind: 'url', url: 'https://x' })).toBe(true);
    expect(isBackgroundReady({ kind: 'prompt', prompt: '' })).toBe(false);
    expect(isBackgroundReady({ kind: 'prompt', prompt: 'cozy' })).toBe(true);
  });

  it('isProductReady is false for empty, true for any other source', () => {
    expect(isProductReady({ id: 'a', source: { kind: 'empty' } })).toBe(false);
    expect(isProductReady({ id: 'a', source: { kind: 'uploaded', asset: { path: 'p' } } })).toBe(true);
    expect(isProductReady({ id: 'a', source: { kind: 'url', url: 'https://x', urlInput: 'x' } })).toBe(true);
  });

  it('isHostReady returns false during the v9 transitional phase', () => {
    // v9 (streaming-resume Phase B): readiness has moved to the
    // server-side generation_jobs row + a yet-to-be-introduced
    // host.selected field. Until step 17 wires those, isHostReady
    // returns false for every input — test the placeholder so a
    // future regression to "always returns true" is loud.
    expect(
      isHostReady({
        input: { kind: 'text', prompt: '', builder: {}, negativePrompt: '', extraPrompt: '' },
        temperature: 0.7,
        generation: { state: 'idle' },
      }),
    ).toBe(false);
    expect(
      isHostReady({
        input: { kind: 'text', prompt: '', builder: {}, negativePrompt: '', extraPrompt: '' },
        temperature: 0.7,
        generation: { state: 'attached', jobId: 'job-x' },
      }),
    ).toBe(false);
  });

  it('isVoiceReady tts requires voiceId + script + ready generation', () => {
    expect(
      isVoiceReady({
        source: 'tts',
        voiceId: null,
        voiceName: null,
        advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 },
        script: { paragraphs: ['hi'] },
        generation: { state: 'idle' },
      }),
    ).toBe(false);
    expect(
      isVoiceReady({
        source: 'tts',
        voiceId: 'v',
        voiceName: 'V',
        advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 },
        script: { paragraphs: ['hi'] },
        generation: { state: 'ready', audio: { path: 'a/b' } },
      }),
    ).toBe(true);
  });
});
