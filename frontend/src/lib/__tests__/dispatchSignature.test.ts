/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { computeDispatchSignature } from '../dispatchSignature';

describe('computeDispatchSignature', () => {
  const baseState = {
    voice: {
      source: 'tts',
      generation: { state: 'ready', audio: { key: '/uploads/tts.wav' } },
      script: { paragraphs: ['안녕하세요', '오늘 소개할 제품은'] },
    },
    composition: {
      generation: { state: 'ready', selected: { key: '/composites/c1.png' } },
    },
    host: null,
    resolution: '1080p',
    seed: 9999,
  };

  it('produces a stable string for the same wizard intent', () => {
    const a = computeDispatchSignature(baseState);
    const b = computeDispatchSignature({ ...baseState });
    expect(a).toBe(b);
  });

  it('changes when audio path changes (refresh-after-new-tts must re-dispatch)', () => {
    const a = computeDispatchSignature(baseState);
    const b = computeDispatchSignature({
      ...baseState,
      voice: {
        ...baseState.voice,
        generation: { state: 'ready', audio: { key: '/uploads/tts-other.wav' } },
      },
    });
    expect(a).not.toBe(b);
  });

  it('changes when host composition changes', () => {
    const a = computeDispatchSignature(baseState);
    const b = computeDispatchSignature({
      ...baseState,
      composition: {
        generation: { state: 'ready', selected: { key: '/composites/c2.png' } },
      },
    });
    expect(a).not.toBe(b);
  });

  it('changes when script changes', () => {
    const a = computeDispatchSignature(baseState);
    const b = computeDispatchSignature({
      ...baseState,
      voice: {
        ...baseState.voice,
        script: { paragraphs: ['전혀 다른 대본'] },
      },
    });
    expect(a).not.toBe(b);
  });

  it('changes when resolution changes', () => {
    const a = computeDispatchSignature(baseState);
    const b = computeDispatchSignature({ ...baseState, resolution: '720p' });
    expect(a).not.toBe(b);
  });

  it('falls back to host path when composition is not ready', () => {
    const noComp = {
      ...baseState,
      composition: null,
      host: {
        generation: { state: 'ready', selected: { key: '/hosts/h1.png' } },
      },
    };
    const sig = computeDispatchSignature(noComp);
    expect(sig).toContain('host:/hosts/h1.png');
  });

  it('handles upload-mode audio (path lives at voice.audio.path, not voice.generation)', () => {
    const upload = {
      ...baseState,
      voice: {
        source: 'upload',
        audio: { key: '/uploads/raw.wav' },
        script: { paragraphs: [] },
      },
    };
    const sig = computeDispatchSignature(upload);
    expect(sig).toContain('/uploads/raw.wav');
  });

  it('does not throw on null / undefined / partial state', () => {
    expect(() => computeDispatchSignature(null)).not.toThrow();
    expect(() => computeDispatchSignature(undefined)).not.toThrow();
    expect(() => computeDispatchSignature({})).not.toThrow();
    expect(computeDispatchSignature(null)).toBe(computeDispatchSignature(undefined));
  });
});
