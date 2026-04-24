/**
 * wizardStore persistence — round-trip contract.
 *
 * User-reported bug (pre-refactor): "1단계 2단계에서 이미 생성한 이미지들을
 * 새로고침하면 다 사라지는데 이것도 다 살려줘". These tests pin the invariant
 * that survived the Phase 2b migration to Zustand + persist middleware:
 * finished variants survive, placeholder/error entries don't, and
 * reference photos with server URLs survive (while data:/blob: URLs
 * tied to a dead tab get dropped along with the File handles).
 *
 * Direct test of `partializeForPersist` — the middleware uses this
 * same function at save time, so any field it strips is exactly what
 * localStorage will see after a setState.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { INITIAL_WIZARD_STATE, __wizardStoreInternals } from '../../stores/wizardStore';

const { partializeForPersist } = __wizardStoreInternals;

// Helper: persist → JSON round-trip → parse. Mirrors what Zustand's
// persist middleware does on every state write.
function roundtrip(state) {
  const serialized = JSON.stringify(partializeForPersist(state));
  return JSON.parse(serialized);
}

describe('wizardStore persistence', () => {
  it('preserves finished host variants across reload', () => {
    const state = {
      ...INITIAL_WIZARD_STATE,
      host: {
        ...INITIAL_WIZARD_STATE.host,
        variants: [
          { seed: 10, id: 'v10', url: '/api/files/host_a.png', path: '/srv/host_a.png', placeholder: false },
          { seed: 42, id: 'v42', url: '/api/files/host_b.png', path: '/srv/host_b.png', placeholder: false },
          { seed: 77, id: 'v77', url: '/api/files/host_c.png', path: '/srv/host_c.png', placeholder: false },
          { seed: 128, id: 'v128', url: '/api/files/host_d.png', path: '/srv/host_d.png', placeholder: false },
        ],
      },
    };
    const restored = roundtrip(state);
    expect(restored.host.variants).toHaveLength(4);
    expect(restored.host.variants.map(v => v.seed)).toEqual([10, 42, 77, 128]);
    expect(restored.host.variants[0].url).toBe('/api/files/host_a.png');
  });

  it('strips placeholder variants (mid-stream state should NOT persist)', () => {
    const state = {
      ...INITIAL_WIZARD_STATE,
      host: {
        ...INITIAL_WIZARD_STATE.host,
        variants: [
          { seed: 10, id: 'v10', placeholder: true },
          { seed: 42, id: 'v42', url: '/api/files/host_b.png', placeholder: false },
          { seed: 77, id: 'v77', error: 'failed', placeholder: false },
          { seed: 128, id: 'v128', placeholder: true },
        ],
      },
    };
    const restored = roundtrip(state);
    expect(restored.host.variants).toHaveLength(1);
    expect(restored.host.variants[0].seed).toBe(42);
  });

  it('preserves finished composition variants (Step 2) symmetrically', () => {
    const state = {
      ...INITIAL_WIZARD_STATE,
      composition: {
        ...INITIAL_WIZARD_STATE.composition,
        variants: [
          { seed: 10, id: 'c10', url: '/api/files/c_a.png', path: '/srv/c_a.png', placeholder: false },
          { seed: 42, id: 'c42', url: '/api/files/c_b.png', path: '/srv/c_b.png', placeholder: false },
        ],
      },
    };
    const restored = roundtrip(state);
    expect(restored.composition.variants).toHaveLength(2);
    expect(restored.composition.variants[0].path).toBe('/srv/c_a.png');
  });

  it('preserves face/outfit ref when url is a server URL', () => {
    const state = {
      ...INITIAL_WIZARD_STATE,
      host: {
        ...INITIAL_WIZARD_STATE.host,
        faceRef: { name: 'face.png', size: 4096, type: 'image/png', url: '/api/files/face_abc.png', _file: {} },
        outfitRef: { name: 'outfit.png', size: 8192, type: 'image/png', url: '/api/files/outfit_def.png', _file: {} },
        faceRefPath: '/srv/face_abc.png',
      },
    };
    const restored = roundtrip(state);
    expect(restored.host.faceRef).toBeTruthy();
    expect(restored.host.faceRef.url).toBe('/api/files/face_abc.png');
    expect(restored.host.faceRef._file).toBeUndefined();  // File handle stripped
    expect(restored.host.outfitRef.url).toBe('/api/files/outfit_def.png');
    expect(restored.host.faceRefPath).toBe('/srv/face_abc.png');
  });

  it('drops face/outfit ref when url is a transient data:/blob: URL', () => {
    const state = {
      ...INITIAL_WIZARD_STATE,
      host: {
        ...INITIAL_WIZARD_STATE.host,
        faceRef: { name: 'face.png', url: 'data:image/png;base64,iVBOR...', _file: {} },
        outfitRef: { name: 'outfit.png', url: 'blob:http://localhost/abc', _file: {} },
      },
    };
    const restored = roundtrip(state);
    expect(restored.host.faceRef).toBeNull();
    expect(restored.host.outfitRef).toBeNull();
  });

  it('strips product `_file` handles but keeps server paths', () => {
    const state = {
      ...INITIAL_WIZARD_STATE,
      products: [
        { id: 'p1', name: 'Product A', path: '/srv/p1.png', url: '/api/files/p1.png', _file: {} },
        { id: 'p2', name: 'Product B', path: '/srv/p2.png', url: 'blob:http://localhost/xyz', _file: {} },
      ],
    };
    const restored = roundtrip(state);
    expect(restored.products).toHaveLength(2);
    expect(restored.products[0]._file).toBeUndefined();
    expect(restored.products[0].path).toBe('/srv/p1.png');
    // blob URL dropped, but path (server-side) survives so the row can be
    // re-used without a re-upload.
    expect(restored.products[1].url).toBeNull();
    expect(restored.products[1].path).toBe('/srv/p2.png');
  });

  it('keeps voice.uploadedAudio when a server path exists, drops when only a File', () => {
    const withPath = {
      ...INITIAL_WIZARD_STATE,
      voice: { ...INITIAL_WIZARD_STATE.voice, uploadedAudio: { path: '/srv/tts.wav', name: 'tts.wav', _file: {} } },
    };
    expect(roundtrip(withPath).voice.uploadedAudio.path).toBe('/srv/tts.wav');
    expect(roundtrip(withPath).voice.uploadedAudio._file).toBeUndefined();

    const onlyFile = {
      ...INITIAL_WIZARD_STATE,
      voice: { ...INITIAL_WIZARD_STATE.voice, uploadedAudio: { name: 'tts.wav', _file: {} } },
    };
    expect(roundtrip(onlyFile).voice.uploadedAudio).toBeNull();
  });

  it('restores image quality, resolution, and other top-level knobs', () => {
    const state = {
      ...INITIAL_WIZARD_STATE,
      imageQuality: '2K',
      resolution: { key: '720p', label: '720p', width: 720, height: 1280, size: '28MB' },
    };
    const restored = roundtrip(state);
    expect(restored.imageQuality).toBe('2K');
    expect(restored.resolution.key).toBe('720p');
  });
});
