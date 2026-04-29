/**
 * Phase 4-A — src/studio/api.js mapping layer unit tests.
 *
 * Covers mapping helpers (pure functions) + body builders (FormData shape).
 * Network paths are exercised in Phase 4-B/C/D with a mocked fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  negativeToSystemSuffix,
  strengthToClause,
  stringifyResolution,
  parseResolution,
  paragraphsToScript,
  humanizeError,
  buildHostGenerateBody,
  buildCompositeBody,
  uploadHostImage,
  makeRandomSeeds,
} from '../api.js';

describe('api.js — negativeToSystemSuffix §5.1.1', () => {
  it('empty or whitespace → ""', () => {
    expect(negativeToSystemSuffix('')).toBe('');
    expect(negativeToSystemSuffix('   ')).toBe('');
    expect(negativeToSystemSuffix(undefined)).toBe('');
  });
  it('preserves Korean verbatim (NO translation per §5.1.1)', () => {
    const s = negativeToSystemSuffix('안경 안 쓴 모습');
    expect(s).toBe('\n\nAvoid the following in the output: 안경 안 쓴 모습');
  });
});

describe('api.js — strengthToClause §5.1.2 thresholds', () => {
  it('0.0 → loose inspiration', () => {
    expect(strengthToClause(0.0, 'face')).toMatch(/loose inspiration/);
  });
  it('0.29 → loose inspiration (just under 0.3)', () => {
    expect(strengthToClause(0.29, 'face')).toMatch(/loose inspiration/);
  });
  it('0.30 → general style guide (boundary)', () => {
    expect(strengthToClause(0.30, 'face')).toMatch(/general style guide/);
  });
  it('0.59 → general style guide', () => {
    expect(strengthToClause(0.59, 'face')).toMatch(/general style guide/);
  });
  it('0.60 → preserve key features (boundary)', () => {
    expect(strengthToClause(0.60, 'face')).toMatch(/Preserve the key features/);
  });
  it('0.84 → preserve key features', () => {
    expect(strengthToClause(0.84, 'face')).toMatch(/Preserve the key features/);
  });
  it('0.85 → match exactly (boundary)', () => {
    expect(strengthToClause(0.85, 'face')).toMatch(/Match the reference face as exactly as possible/);
  });
  it('1.0 → match exactly', () => {
    expect(strengthToClause(1.0, 'face')).toMatch(/Match the reference face as exactly as possible/);
  });
  it('outfit kind swaps the noun', () => {
    expect(strengthToClause(0.5, 'outfit')).toMatch(/outfit as a general style guide/);
  });
  it('null strength → ""', () => {
    expect(strengthToClause(null, 'face')).toBe('');
    expect(strengthToClause(undefined, 'outfit')).toBe('');
  });
});

describe('api.js — resolution mapping §5.3', () => {
  it('portrait {width:448, height:768} → "768x448" (H-first)', () => {
    expect(stringifyResolution({ width: 448, height: 768 })).toBe('768x448');
  });
  it('landscape {width:1280, height:720} → "720x1280"', () => {
    expect(stringifyResolution({ width: 1280, height: 720 })).toBe('720x1280');
  });
  it('parseResolution is symmetric with stringify', () => {
    const r = { width: 448, height: 768 };
    expect(parseResolution(stringifyResolution(r))).toEqual(r);
  });
  it('parseResolution rejects garbage', () => {
    expect(() => parseResolution('not-a-resolution')).toThrow();
    expect(() => parseResolution('')).toThrow();
  });
  it('stringifyResolution rejects missing width/height', () => {
    expect(() => stringifyResolution({})).toThrow();
    expect(() => stringifyResolution({ width: 100 })).toThrow();
  });
});

describe('api.js — paragraphsToScript §5.3 + §5.4', () => {
  it('joins with " [breath] " for tts mode', () => {
    expect(paragraphsToScript(['안녕하세요', '반갑습니다'], { source: 'tts' }))
      .toBe('안녕하세요 [breath] 반갑습니다');
  });
  it('joins with " [breath] " for clone mode (same as tts)', () => {
    expect(paragraphsToScript(['A', 'B'], { source: 'clone' }))
      .toBe('A [breath] B');
  });
  it('single paragraph → no [breath] inserted', () => {
    expect(paragraphsToScript(['혼자입니다'], { source: 'tts' })).toBe('혼자입니다');
  });
  it('upload mode uses plain newline separators (no [breath])', () => {
    expect(paragraphsToScript(['A', 'B'], { source: 'upload' })).toBe('A\n\nB');
  });
  it('drops empty / whitespace paragraphs', () => {
    expect(paragraphsToScript(['A', '', '  ', 'B'], { source: 'tts' }))
      .toBe('A [breath] B');
  });
  it('enforces 5000-char limit including [breath] tokens', () => {
    const huge = 'x'.repeat(5000);
    expect(() => paragraphsToScript([huge, huge], { source: 'tts' })).toThrow(/너무 길어요/);
  });
  it('non-array input throws', () => {
    expect(() => paragraphsToScript('oops', { source: 'tts' })).toThrow();
  });
});

describe('api.js — humanizeError', () => {
  it('429 → 붐벼요 copy', () => {
    expect(humanizeError({ status: 429 })).toMatch(/붐벼요/);
  });
  it('401 → 다시 로그인 copy', () => {
    expect(humanizeError({ status: 401 })).toMatch(/로그인/);
  });
  it('403 → 관리자 문의 copy', () => {
    expect(humanizeError({ status: 403 })).toMatch(/관리자/);
  });
  it('413 → 파일 크기 copy', () => {
    expect(humanizeError({ status: 413 })).toMatch(/너무 커요/);
  });
  it('503 → 결과 부족 copy', () => {
    expect(humanizeError({ status: 503 })).toMatch(/부족/);
  });
  it('TypeError → 네트워크 copy', () => {
    expect(humanizeError({ name: 'TypeError', message: 'failed to fetch' })).toMatch(/네트워크/);
  });
  it('null → 알 수 없는 오류', () => {
    expect(humanizeError(null)).toMatch(/알 수 없는/);
  });
});

describe('api.js — buildHostGenerateBody', () => {
  const formToObject = (fd) => {
    const o = {};
    for (const [k, v] of fd.entries()) o[k] = v;
    return o;
  };

  it('mode=text → body.mode="text" with prompt sent verbatim', () => {
    const body = buildHostGenerateBody({
      mode: 'text',
      prompt: '밝고 친근한 쇼호스트',
    });
    const o = formToObject(body);
    expect(o.mode).toBe('text');
    expect(o.prompt).toBe('밝고 친근한 쇼호스트');
    expect(o.builder).toBeUndefined();
  });

  it('faceRef + outfitRef → mode=face-outfit, strength clauses fold into extraPrompt', () => {
    const body = buildHostGenerateBody({
      mode: 'image',
      faceRef: { name: 'face.png' }, faceRefPath: '/uploads/face.png', faceStrength: 0.9,
      outfitRef: { name: 'outfit.png' }, outfitRefPath: '/uploads/outfit.png', outfitStrength: 0.4,
      negativePrompt: '어두운 표정',
    });
    const o = formToObject(body);
    expect(o.mode).toBe('face-outfit');
    expect(o.faceRefPath).toBe('/uploads/face.png');
    expect(o.outfitRefPath).toBe('/uploads/outfit.png');
    expect(o.faceStrength).toBe('0.9');
    expect(o.outfitStrength).toBe('0.4');
    expect(o.extraPrompt).toMatch(/Match the reference face/);
    expect(o.extraPrompt).toMatch(/outfit as a general style guide/);
    expect(o.extraPrompt).toMatch(/어두운 표정/);
    expect(o.negativePrompt).toBe('어두운 표정');
  });

  it('faceRef only (no outfit) → mode=style-ref', () => {
    const body = buildHostGenerateBody({
      mode: 'image',
      faceRef: { name: 'face.png' }, faceRefPath: '/uploads/face.png',
    });
    const o = formToObject(body);
    expect(o.mode).toBe('style-ref');
  });

  it('sends temperature when set (UI picked a Segmented value)', () => {
    const body = buildHostGenerateBody({
      mode: 'text', prompt: 'x'.repeat(20), temperature: 0.4,
    });
    const o = formToObject(body);
    expect(o.temperature).toBe('0.4');
  });

  it('omits temperature when not a number (undefined/null)', () => {
    const body = buildHostGenerateBody({ mode: 'text', prompt: 'x'.repeat(20) });
    const o = formToObject(body);
    expect(o.temperature).toBeUndefined();
  });
});

describe('api.js — buildCompositeBody', () => {
  const host = { selectedPath: '/uploads/host.png' };
  const products = [
    { key: '/uploads/p1.png', name: 'p1' },
    { key: '/uploads/p2.png', name: 'p2' },
  ];
  const composition = { direction: '밝은 분위기', shot: 'bust', angle: 'eye' };

  const formToObject = (fd) => {
    const o = {};
    for (const [k, v] of fd.entries()) o[k] = v;
    return o;
  };

  it('prompt background → backgroundType=prompt + backgroundPrompt', () => {
    const body = buildCompositeBody({
      host, products, composition,
      background: { source: 'prompt', prompt: 'modern studio' },
    });
    const o = formToObject(body);
    expect(o.backgroundType).toBe('prompt');
    expect(o.backgroundPrompt).toBe('modern studio');
    expect(o.hostImagePath).toBe('/uploads/host.png');
    expect(o.productImagePaths).toBe(JSON.stringify(['/uploads/p1.png', '/uploads/p2.png']));
    expect(o.direction).toBe('밝은 분위기');
    expect(o.shot).toBe('bust');
    expect(o.angle).toBe('eye');
  });

  it('preset background → backgroundType=preset + backgroundPresetId', () => {
    const body = buildCompositeBody({
      host, products, composition,
      background: { source: 'preset', preset: { id: 'studio_white', label: '깔끔한 화이트' } },
    });
    const o = formToObject(body);
    expect(o.backgroundType).toBe('preset');
    expect(o.backgroundPresetId).toBe('studio_white');
    expect(o.backgroundPresetLabel).toBe('깔끔한 화이트');
  });

  it('upload background → backgroundType=upload + backgroundUploadPath', () => {
    const body = buildCompositeBody({
      host, products, composition,
      background: { source: 'upload', uploadPath: '/uploads/bg.png' },
    });
    const o = formToObject(body);
    expect(o.backgroundType).toBe('upload');
    expect(o.backgroundUploadPath).toBe('/uploads/bg.png');
  });

  it('throws if host.selectedPath missing', () => {
    expect(() => buildCompositeBody({
      host: {}, products, composition,
      background: { source: 'prompt', prompt: 'x' },
    })).toThrow(/1단계/);
  });

  it('throws if prompt background has no text', () => {
    expect(() => buildCompositeBody({
      host, products, composition,
      background: { source: 'prompt', prompt: '' },
    })).toThrow(/배경 설명/);
  });

  it('sends composition.temperature when set', () => {
    const body = buildCompositeBody({
      host, products,
      composition: { ...composition, temperature: 1.0 },
      background: { source: 'prompt', prompt: 'studio' },
    });
    const o = formToObject(body);
    expect(o.temperature).toBe('1');
  });

  it('omits temperature when composition.temperature is not a number', () => {
    const body = buildCompositeBody({
      host, products, composition,
      background: { source: 'prompt', prompt: 'studio' },
    });
    const o = formToObject(body);
    expect(o.temperature).toBeUndefined();
  });
});

describe('api.js — upload choreography', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts to /api/upload/host-image and returns parsed JSON', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ key: '/uploads/host_123.png', filename: 'host_123.png' }),
    });
    const file = new File(['x'], 'host.png', { type: 'image/png' });
    const r = await uploadHostImage(file);
    expect(r.key).toBe('/uploads/host_123.png');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/upload\/host-image$/),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws on >20MB file before network call', async () => {
    const big = new File([new Uint8Array(21 * 1024 * 1024)], 'huge.png', { type: 'image/png' });
    await expect(uploadHostImage(big)).rejects.toThrow(/20MB/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('surfaces backend error detail', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ detail: 'Not a valid image file' }),
    });
    const file = new File(['x'], 'fake.png', { type: 'image/png' });
    await expect(uploadHostImage(file)).rejects.toThrow(/Not a valid image file/);
  });
});

describe('api.js — seed override on retry', () => {
  it('makeRandomSeeds returns N positive ints', () => {
    const out = makeRandomSeeds(4);
    expect(out).toHaveLength(4);
    out.forEach(s => {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(2_147_483_647);
    });
  });

  it('makeRandomSeeds produces different sets on consecutive calls', () => {
    // Vanishingly unlikely to collide on all 4 seeds with 31-bit range.
    const a = makeRandomSeeds(4);
    const b = makeRandomSeeds(4);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('buildHostGenerateBody omits seeds when host._seeds is absent (first attempt)', () => {
    const body = buildHostGenerateBody({ mode: 'text', prompt: 'x' });
    expect(body.get('seeds')).toBeNull();
  });

  it('buildHostGenerateBody serializes host._seeds as JSON string when present', () => {
    const body = buildHostGenerateBody({ mode: 'text', prompt: 'x', _seeds: [11, 22, 33, 44] });
    expect(body.get('seeds')).toBe('[11,22,33,44]');
  });

  it('buildCompositeBody omits seeds without composition._seeds', () => {
    const body = buildCompositeBody({
      host: { selectedPath: '/x/host.png' },
      products: [],
      background: { source: 'prompt', prompt: 'studio' },
      composition: { direction: 'pose' },
    });
    expect(body.get('seeds')).toBeNull();
  });

  it('buildCompositeBody serializes composition._seeds when present', () => {
    const body = buildCompositeBody({
      host: { selectedPath: '/x/host.png' },
      products: [],
      background: { source: 'prompt', prompt: 'studio' },
      composition: { direction: 'pose', _seeds: [5, 6, 7, 8] },
    });
    expect(body.get('seeds')).toBe('[5,6,7,8]');
  });
});


describe('api.js — shared imageSize on both body builders', () => {
  it('buildHostGenerateBody omits imageSize when absent', () => {
    const body = buildHostGenerateBody({ mode: 'text', prompt: 'x' });
    expect(body.get('imageSize')).toBeNull();
  });

  it('buildHostGenerateBody sends imageSize when present (2K)', () => {
    const body = buildHostGenerateBody({ mode: 'text', prompt: 'x', imageSize: '2K' });
    expect(body.get('imageSize')).toBe('2K');
  });

  it('buildCompositeBody sends imageSize piggybacked on composition', () => {
    const body = buildCompositeBody({
      host: { selectedPath: '/x/host.png' },
      products: [],
      background: { source: 'prompt', prompt: 'studio' },
      composition: { direction: 'pose', imageSize: '2K' },
    });
    expect(body.get('imageSize')).toBe('2K');
  });
});


describe('api.js — generateVideo attaches full provenance meta', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task_id: 'abc' }),
    });
  });
  afterEach(() => { global.fetch = undefined; });

  it('includes host, composition, products, background, voice, imageQuality in meta blob', async () => {
    const { generateVideo } = await import('../api.js');
    const state = {
      // Phase 2b: schema-shaped host. input is a tagged union;
      // generation is a state machine with `selected` carrying the
      // committed pick.
      host: {
        input: {
          kind: 'image',
          faceRef: { path: '/srv/face.png' },
          outfitRef: null,
          outfitText: '베이지 니트',
          extraPrompt: '',
          faceStrength: 0.7,
          outfitStrength: 0.5,
        },
        temperature: 1.0,
        generation: {
          state: 'ready',
          batchId: null,
          variants: [
            { seed: 42, imageId: 'host_42', url: '/api/files/host_42.png', key: '/srv/host_42.png' },
          ],
          selected: { seed: 42, imageId: 'host_42', url: '/api/files/host_42.png', key: '/srv/host_42.png' },
          prevSelected: null,
        },
      },
      // Phase 2c: schema-shaped composition (settings + generation).
      composition: {
        settings: {
          direction: '소파에 앉아 1번 들기',
          shot: 'medium',
          angle: 'eye',
          temperature: 0.4,
          rembg: true,
        },
        generation: {
          state: 'ready',
          batchId: null,
          variants: [
            { seed: 77, imageId: 'c_77', url: '/api/files/c_77.png', key: '/srv/c_77.png' },
          ],
          selected: { seed: 77, imageId: 'c_77', url: '/api/files/c_77.png', key: '/srv/c_77.png' },
          prevSelected: null,
        },
      },
      // Phase 2c: schema-shaped products (tagged source).
      products: [
        { id: 'p1', name: '쿠션', source: { kind: 'uploaded', asset: { key: '/srv/cushion.png' } } },
        { id: 'p2', name: '소파', source: { kind: 'uploaded', asset: { key: '/srv/sofa.png' } } },
      ],
      // Phase 2a: schema-shaped tagged union. presetLabel is dropped
      // from the schema (it's a derived UI field, looked up from
      // BG_PRESETS) so the provenance carries presetId only.
      background: { kind: 'preset', presetId: 'living_cozy' },
      // Phase 2c.4: schema-shaped voice (tagged union over source).
      // tts/clone carry generation state machine + advanced settings;
      // upload bypasses TTS. voiceProvenance flattens this back to the
      // legacy provenance keys the backend manifest expects.
      voice: {
        source: 'tts',
        voiceId: 'v_minji',
        voiceName: '민지',
        advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 },
        script: { paragraphs: ['안녕하세요'] },
        generation: { state: 'ready', audio: { path: '/srv/a.wav' } },
      },
      // Phase 2c: schema-shaped resolution is just the key — meta
      // (width/height/label) derived via RESOLUTION_META.
      resolution: '720p',
      imageQuality: '2K',
    };
    await generateVideo({ state, audio: { audio_path: '/srv/a.wav' } });

    const [, opts] = global.fetch.mock.calls[0];
    const metaStr = opts.body.get('meta');
    expect(metaStr).toBeTruthy();
    const meta = JSON.parse(metaStr);
    // Host
    expect(meta.host.mode).toBe('image');
    expect(meta.host.selectedSeed).toBe(42);
    expect(meta.host.temperature).toBe(1.0);
    expect(meta.host.outfitText).toBe('베이지 니트');
    // Composition
    expect(meta.composition.shot).toBe('medium');
    expect(meta.composition.direction).toContain('소파');
    expect(meta.composition.temperature).toBe(0.4);
    // Products (with names + paths)
    expect(meta.products).toHaveLength(2);
    expect(meta.products[0].name).toBe('쿠션');
    // Background
    expect(meta.background.source).toBe('preset');
    expect(meta.background.presetId).toBe('living_cozy');
    expect(meta.background.presetLabel).toBeNull();
    // Voice
    expect(meta.voice.voiceName).toBe('민지');
    expect(meta.voice.script).toBe('안녕하세요');
    // Global
    expect(meta.imageQuality).toBe('2K');
  });
});
