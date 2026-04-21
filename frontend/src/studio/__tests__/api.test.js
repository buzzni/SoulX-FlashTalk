/**
 * Phase 4-A — src/studio/api.js mapping layer unit tests.
 *
 * Covers mapping helpers (pure functions) + body builders (FormData shape).
 * Network paths are exercised in Phase 4-B/C/D with a mocked fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  builderToPromptSuffix,
  negativeToSystemSuffix,
  strengthToClause,
  stringifyResolution,
  parseResolution,
  paragraphsToScript,
  humanizeError,
  buildHostGenerateBody,
  buildCompositeBody,
  uploadHostImage,
} from '../api.js';

describe('api.js — builder ko→en suffix', () => {
  it('returns "" when builder empty', () => {
    expect(builderToPromptSuffix({})).toBe('');
    expect(builderToPromptSuffix(null)).toBe('');
  });
  it('maps 성별/연령대/분위기/옷차림 in fixed order', () => {
    const s = builderToPromptSuffix({
      옷차림: 'formal', 성별: 'female', 연령대: '30s', 분위기: 'bright',
    });
    expect(s).toBe(', female, in her/his 30s, bright and energetic, formal attire');
  });
  it('skips unknown preset values silently', () => {
    expect(builderToPromptSuffix({ 성별: 'unknown' })).toBe('');
  });
});

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
  it('401 → 관리자 문의 copy', () => {
    expect(humanizeError({ status: 401 })).toMatch(/관리자/);
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

  it('mode=text → body.mode="text", builder appended to prompt', () => {
    const body = buildHostGenerateBody({
      mode: 'text',
      prompt: '밝고 친근한 쇼호스트',
      builder: { 성별: 'female', 연령대: '30s' },
    });
    const o = formToObject(body);
    expect(o.mode).toBe('text');
    expect(o.prompt).toBe('밝고 친근한 쇼호스트, female, in her/his 30s');
    expect(o.builder).toBe(JSON.stringify({ 성별: 'female', 연령대: '30s' }));
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
});

describe('api.js — buildCompositeBody', () => {
  const host = { selectedPath: '/uploads/host.png' };
  const products = [
    { path: '/uploads/p1.png', name: 'p1' },
    { path: '/uploads/p2.png', name: 'p2' },
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
      json: async () => ({ path: '/uploads/host_123.png', filename: 'host_123.png' }),
    });
    const file = new File(['x'], 'host.png', { type: 'image/png' });
    const r = await uploadHostImage(file);
    expect(r.path).toBe('/uploads/host_123.png');
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
