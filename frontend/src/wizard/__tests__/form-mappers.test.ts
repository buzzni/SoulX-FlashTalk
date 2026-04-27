/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { hostSliceToFormValues, formValuesToHostSlice } from '../form-mappers';
import type { Host } from '../schema';
import { INITIAL_HOST } from '../schema';

const READY_TEXT_HOST: Host = {
  input: {
    kind: 'text',
    prompt: '30대 여성, 따뜻한 분위기',
    builder: { 성별: 'female' },
    negativePrompt: '',
    extraPrompt: '',
  },
  temperature: 0.7,
  generation: {
    state: 'ready',
    batchId: 'b-1',
    variants: [{ seed: 1, imageId: 'h1', url: '/u/h1.png', path: '/p/h1.png' }],
    selected: { seed: 1, imageId: 'h1', url: '/u/h1.png', path: '/p/h1.png' },
    prevSelected: null,
  },
};

describe('hostSliceToFormValues', () => {
  it('drops generation but keeps input + temperature', () => {
    const values = hostSliceToFormValues(READY_TEXT_HOST);
    expect(values).toEqual({
      input: READY_TEXT_HOST.input,
      temperature: 0.7,
    });
    expect('generation' in values).toBe(false);
  });

  it('round-trips through formValuesToHostSlice with the same generation reference', () => {
    const values = hostSliceToFormValues(READY_TEXT_HOST);
    const restored = formValuesToHostSlice(values, READY_TEXT_HOST);
    expect(restored).toEqual(READY_TEXT_HOST);
    expect(restored.generation).toBe(READY_TEXT_HOST.generation);
  });
});

describe('formValuesToHostSlice', () => {
  it('preserves prev.generation when writing form values', () => {
    const values = {
      input: { ...INITIAL_HOST.input, prompt: 'edited' as string },
      temperature: 0.4,
    } as ReturnType<typeof hostSliceToFormValues>;

    const next = formValuesToHostSlice(values, READY_TEXT_HOST);

    expect(next.generation).toBe(READY_TEXT_HOST.generation);
    expect(next.temperature).toBe(0.4);
    if (next.input.kind === 'text') {
      expect(next.input.prompt).toBe('edited');
    }
  });

  it('replaces the entire input on a tagged-union switch', () => {
    const imageValues = {
      input: {
        kind: 'image' as const,
        faceRef: null,
        outfitRef: null,
        outfitText: '',
        extraPrompt: '',
        faceStrength: 0.7,
        outfitStrength: 0.5,
      },
      temperature: 0.7,
    };

    const next = formValuesToHostSlice(imageValues, READY_TEXT_HOST);

    expect(next.input.kind).toBe('image');
    // No stray prompt field from the previous text-mode input
    expect((next.input as { prompt?: string }).prompt).toBeUndefined();
  });
});
