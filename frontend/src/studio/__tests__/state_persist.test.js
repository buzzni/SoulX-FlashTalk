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
  it('preserves attached(jobId) host generation across reload (v9)', () => {
    // v9 (streaming-resume Phase B): host.generation collapsed to
    // {idle | attached(jobId)}. The jobId is the server-side handle —
    // reload survives because the snapshot endpoint resolves it back to
    // current state. Variants/selected/batchId no longer live on the
    // schema (eng-spec §7); they're sourced via jobCacheStore once
    // step 17 wires it.
    const state = {
      ...INITIAL_WIZARD_STATE,
      host: {
        ...INITIAL_WIZARD_STATE.host,
        generation: { state: 'attached', jobId: 'job-h1' },
      },
    };
    const restored = roundtrip(state);
    expect(restored.host.generation.state).toBe('attached');
    expect(restored.host.generation.jobId).toBe('job-h1');
  });

  it('preserves attached(jobId) composition generation across reload (v9)', () => {
    // Same shape as the host case above — composition.generation
    // collapsed to {idle | attached(jobId)} in v9.
    const state = {
      ...INITIAL_WIZARD_STATE,
      composition: {
        ...INITIAL_WIZARD_STATE.composition,
        generation: { state: 'attached', jobId: 'job-c1' },
      },
    };
    const restored = roundtrip(state);
    expect(restored.composition.generation.state).toBe('attached');
    expect(restored.composition.generation.jobId).toBe('job-c1');
  });

  it('preserves image-mode host face/outfit ServerAsset refs across reload', () => {
    // Phase 2b: image-mode input lives on host.input as a tagged
    // union. ServerAsset (has a path) survives reload; LocalAsset
    // (File handle + blob URL) gets stripped.
    const state = {
      ...INITIAL_WIZARD_STATE,
      host: {
        ...INITIAL_WIZARD_STATE.host,
        input: {
          kind: 'image',
          faceRef: { path: '/srv/face_abc.png', url: '/api/files/face_abc.png', name: 'face.png' },
          outfitRef: { path: '/srv/outfit_def.png', url: '/api/files/outfit_def.png', name: 'outfit.png' },
          outfitText: '베이지 니트',
          extraPrompt: '',
          faceStrength: 0.7,
          outfitStrength: 0.5,
        },
      },
    };
    const restored = roundtrip(state);
    expect(restored.host.input.kind).toBe('image');
    expect(restored.host.input.faceRef.path).toBe('/srv/face_abc.png');
    expect(restored.host.input.faceRef.url).toBe('/api/files/face_abc.png');
    expect(restored.host.input.faceRef.file).toBeUndefined();  // No File handle in ServerAsset
    expect(restored.host.input.outfitRef.path).toBe('/srv/outfit_def.png');
  });

  it('drops LocalAsset face/outfit refs (File handle + transient blob URL) on persist', () => {
    // LocalAsset has { file, previewUrl, name }. Neither survives —
    // persistHost rewrites to null.
    const state = {
      ...INITIAL_WIZARD_STATE,
      host: {
        ...INITIAL_WIZARD_STATE.host,
        input: {
          kind: 'image',
          faceRef: { file: {}, previewUrl: 'blob:http://localhost/abc', name: 'face.png' },
          outfitRef: { file: {}, previewUrl: 'data:image/png;base64,iVBOR...', name: 'outfit.png' },
          outfitText: '',
          extraPrompt: '',
          faceStrength: 0.7,
          outfitStrength: 0.5,
        },
      },
    };
    const restored = roundtrip(state);
    expect(restored.host.input.kind).toBe('image');
    expect(restored.host.input.faceRef).toBeNull();
    expect(restored.host.input.outfitRef).toBeNull();
  });

  it('collapses localFile products to empty on persist; keeps uploaded server paths', () => {
    // Phase 2c.2: products are schema-typed. ProductSource =
    // empty | localFile | uploaded | url. localFile (File + blob)
    // collapses to empty; uploaded (ServerAsset) survives.
    const state = {
      ...INITIAL_WIZARD_STATE,
      products: [
        {
          id: 'p1',
          name: 'Product A (uploaded)',
          source: {
            kind: 'uploaded',
            asset: { path: '/srv/p1.png', url: '/api/files/p1.png', name: 'p1.png' },
          },
        },
        {
          id: 'p2',
          name: 'Product B (local file)',
          source: {
            kind: 'localFile',
            asset: { file: {}, previewUrl: 'blob:http://localhost/xyz', name: 'p2.png' },
          },
        },
        { id: 'p3', name: 'Product C (url)', source: { kind: 'url', url: 'https://x/y.png', urlInput: 'https://x/y.png' } },
      ],
    };
    const restored = roundtrip(state);
    expect(restored.products).toHaveLength(3);
    expect(restored.products[0].source.kind).toBe('uploaded');
    expect(restored.products[0].source.asset.path).toBe('/srv/p1.png');
    expect(restored.products[1].source.kind).toBe('empty');  // local → empty
    expect(restored.products[2].source.kind).toBe('url');
    expect(restored.products[2].source.url).toBe('https://x/y.png');
  });

  it('keeps upload-mode voice.audio when a server path exists, drops LocalAsset uploads', () => {
    // Phase 2c.4: voice is schema-typed. Upload-mode audio lives on
    // `voice.audio` as ServerAsset | LocalAsset | null. ServerAsset
    // (has a real path) survives reload; LocalAsset (File handle +
    // blob URL) gets dropped to null because the File is gone after
    // a refresh.
    const withPath = {
      ...INITIAL_WIZARD_STATE,
      voice: {
        source: 'upload',
        audio: { path: '/srv/tts.wav', name: 'tts.wav' },
        script: { paragraphs: ['caption'] },
      },
    };
    const restoredWithPath = roundtrip(withPath);
    expect(restoredWithPath.voice.audio.path).toBe('/srv/tts.wav');
    expect(restoredWithPath.voice.audio.file).toBeUndefined();

    const onlyFile = {
      ...INITIAL_WIZARD_STATE,
      voice: {
        source: 'upload',
        audio: { file: {}, previewUrl: 'blob:http://localhost/x', name: 'tts.wav' },
        script: { paragraphs: ['caption'] },
      },
    };
    expect(roundtrip(onlyFile).voice.audio).toBeNull();
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
