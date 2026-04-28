/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import {
  toCompositeRequest,
  toHostGenerateRequest,
  toVoiceGenerateRequest,
} from '../api-mappers';
import type { Background, Composition, Host, Products, Voice } from '../schema';
import { INITIAL_COMPOSITION, INITIAL_HOST } from '../schema';

// v9 (streaming-resume Phase B): the schema's "ready + selected" was
// the readiness signal in v8. v9 collapses generation to {idle | attached},
// and the selected variant moves off-schema (step 17 will introduce a
// host.selected field + jobCacheStore lookup). For the duration of step
// 13's transitional phase, toCompositeRequest always returns
// host.selectedPath: null — readiness is no longer schema-derivable.
// Tests below assert that null contract; once step 17 lands they'll
// migrate back to a "selected variant threads through" assertion.
const READY_HOST: Host = {
  input: { kind: 'text', prompt: 'a'.repeat(20), builder: {}, negativePrompt: '', extraPrompt: '' },
  temperature: 0.7,
  generation: { state: 'attached', jobId: 'job-h1' },
};

const TWO_PRODUCTS: Products = [
  {
    id: 'p1',
    name: 'p1.png',
    source: { kind: 'uploaded', asset: { path: '/uploads/p1.png', url: '/u/p1.png', name: 'p1' } },
  },
  {
    id: 'p2',
    name: 'p2.png',
    source: { kind: 'url', url: 'https://example.com/p2.png', urlInput: 'https://example.com/p2.png' },
  },
];

const READY_COMPOSITION: Composition = {
  ...INITIAL_COMPOSITION,
  settings: {
    direction: '소파에 앉아 1번 들고 있음',
    shot: 'medium',
    angle: 'eye',
    temperature: 0.7,
    rembg: true,
  },
};

describe('toCompositeRequest', () => {
  it('returns null host.selectedPath during the v9 transitional phase', () => {
    // step 17 will restore "host.selected.path threads through" once
    // jobCacheStore + host.selected ship.
    const req = toCompositeRequest({
      host: READY_HOST,
      products: [],
      background: { kind: 'preset', presetId: 'studio_white' },
      composition: READY_COMPOSITION,
      imageQuality: '1K',
    });
    expect(req.host.selectedPath).toBeNull();
  });

  it('returns null host.selectedPath when host generation is not ready', () => {
    const req = toCompositeRequest({
      host: INITIAL_HOST,
      products: [],
      background: { kind: 'preset', presetId: null },
      composition: READY_COMPOSITION,
      imageQuality: '1K',
    });
    expect(req.host.selectedPath).toBeNull();
  });

  it('maps uploaded products to {path} and external-url products to {path: url}', () => {
    const req = toCompositeRequest({
      host: READY_HOST,
      products: TWO_PRODUCTS,
      background: { kind: 'preset', presetId: 'studio_white' },
      composition: READY_COMPOSITION,
      imageQuality: '1K',
    });
    expect(req.products).toEqual([
      { path: '/uploads/p1.png' },
      { path: 'https://example.com/p2.png' },
    ]);
  });

  it('drops empty + localFile products from the API payload', () => {
    const file = new File(['x'], 'pending.png', { type: 'image/png' });
    const products: Products = [
      { id: 'a', source: { kind: 'empty' } },
      {
        id: 'b',
        source: { kind: 'localFile', asset: { file, previewUrl: 'data:...', name: 'pending.png' } },
      },
      ...TWO_PRODUCTS,
    ];
    const req = toCompositeRequest({
      host: READY_HOST,
      products,
      background: { kind: 'preset', presetId: 'studio_white' },
      composition: READY_COMPOSITION,
      imageQuality: '1K',
    });
    expect(req.products).toHaveLength(2);
    expect(req.products?.[0]).toEqual({ path: '/uploads/p1.png' });
  });

  it('translates 4 background variants to the composite background shape', () => {
    const cases: { bg: Background; expected: unknown }[] = [
      { bg: { kind: 'preset', presetId: 'studio_white' }, expected: { source: 'preset', preset: 'studio_white' } },
      {
        bg: { kind: 'upload', asset: { path: '/u/bg.png', url: '/u/bg.png', name: 'bg' } },
        expected: { source: 'upload', uploadPath: '/u/bg.png' },
      },
      { bg: { kind: 'url', url: 'https://x/y.png' }, expected: { source: 'url', url: 'https://x/y.png' } },
      { bg: { kind: 'prompt', prompt: 'a sunny kitchen' }, expected: { source: 'prompt', prompt: 'a sunny kitchen' } },
    ];
    for (const { bg, expected } of cases) {
      const req = toCompositeRequest({
        host: READY_HOST,
        products: [],
        background: bg,
        composition: READY_COMPOSITION,
        imageQuality: '1K',
      });
      expect(req.background).toEqual(expected);
    }
  });

  it('drops upload-mode background path when asset is a LocalAsset (not yet uploaded)', () => {
    const file = new File(['x'], 'bg.png', { type: 'image/png' });
    const req = toCompositeRequest({
      host: READY_HOST,
      products: [],
      background: { kind: 'upload', asset: { file, previewUrl: 'data:...', name: 'bg.png' } },
      composition: READY_COMPOSITION,
      imageQuality: '1K',
    });
    expect(req.background).toEqual({ source: 'upload', uploadPath: null });
  });

  it('nests imageSize inside composition (canonical wire shape)', () => {
    const req = toCompositeRequest({
      host: READY_HOST,
      products: [],
      background: { kind: 'preset', presetId: 'studio_white' },
      composition: READY_COMPOSITION,
      imageQuality: '2K',
    });
    expect(req.composition?.imageSize).toBe('2K');
    expect(req.composition?.direction).toBe('소파에 앉아 1번 들고 있음');
  });
});

describe('toHostGenerateRequest', () => {
  it('emits text-mode payload with builder dropped when empty', () => {
    const req = toHostGenerateRequest(INITIAL_HOST, '1K');
    expect(req.mode).toBe('text');
    expect(req.builder).toBeNull();
    expect(req.imageSize).toBe('1K');
  });

  it('attaches _seeds when provided (attempt > 0 path)', () => {
    const req = toHostGenerateRequest(INITIAL_HOST, '1K', [11, 22, 33, 44]);
    expect(req._seeds).toEqual([11, 22, 33, 44]);
  });
});

describe('toVoiceGenerateRequest', () => {
  const ADVANCED = { speed: 1.1, stability: 0.5, style: 0.3, similarity: 0.75 };
  const SCRIPT = { paragraphs: ['첫 문단', '두 번째 문단'] };

  it('tts mode emits voiceId from voice.voiceId', () => {
    const v: Voice = {
      source: 'tts',
      voiceId: 'v_minji',
      voiceName: '민지',
      advanced: ADVANCED,
      script: SCRIPT,
      generation: { state: 'idle' },
    };
    const req = toVoiceGenerateRequest(v);
    expect(req.voice.source).toBe('tts');
    expect(req.voice.voiceId).toBe('v_minji');
    expect(req.voice.paragraphs).toEqual(['첫 문단', '두 번째 문단']);
    expect(req.voice.speed).toBe(1.1);
    expect(req.voice.similarity).toBe(0.75);
  });

  it('clone mode emits voiceId from sample.voiceId after clone', () => {
    const v: Voice = {
      source: 'clone',
      sample: { state: 'cloned', voiceId: 'cloned_001', name: '내 목소리' },
      advanced: ADVANCED,
      script: SCRIPT,
      generation: { state: 'idle' },
    };
    const req = toVoiceGenerateRequest(v);
    expect(req.voice.source).toBe('clone');
    expect(req.voice.voiceId).toBe('cloned_001');
    expect(req.voice.paragraphs).toEqual(['첫 문단', '두 번째 문단']);
    expect(req.voice.stability).toBe(0.5);
  });

  it('clone mode with non-cloned sample falls back to null voiceId', () => {
    const v: Voice = {
      source: 'clone',
      sample: { state: 'empty' },
      advanced: ADVANCED,
      script: SCRIPT,
      generation: { state: 'idle' },
    };
    const req = toVoiceGenerateRequest(v);
    expect(req.voice.voiceId).toBeNull();
  });

  it('upload mode throws — caller must guard', () => {
    const v: Voice = {
      source: 'upload',
      audio: null,
      script: SCRIPT,
    };
    expect(() => toVoiceGenerateRequest(v)).toThrow(/upload-mode/);
  });
});
