/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import {
  hostSliceToFormValues,
  formValuesToHostSlice,
  Step2FormValuesSchema,
  Step3FormValuesSchema,
  voiceSliceToFormValues,
  formValuesToVoiceSlice,
} from '../form-mappers';
import type { Host, Voice } from '../schema';
import { INITIAL_HOST } from '../schema';

// v9 (streaming-resume Phase B): generation is {idle | attached(jobId)}.
// "Ready" state with variants/selected lives off-schema until step 17.
const READY_TEXT_HOST: Host = {
  input: {
    kind: 'text',
    prompt: '30대 여성, 따뜻한 분위기',
    builder: { 성별: 'female' },
    negativePrompt: '',
    extraPrompt: '',
  },
  temperature: 0.7,
  generation: { state: 'attached', jobId: 'job-h1' },
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

describe('Step2FormValuesSchema', () => {
  it('parses a complete Step 2 form payload', () => {
    const valid = {
      products: [
        {
          id: 'p1',
          source: {
            kind: 'uploaded',
            asset: { path: '/uploads/p1.png', url: '/u/p1.png', name: 'p1' },
          },
        },
      ],
      background: { kind: 'preset', presetId: 'studio_white' },
      settings: {
        direction: '소파에 앉아 1번을 들고 있음',
        shot: 'medium',
        angle: 'eye',
        temperature: 0.7,
        rembg: true,
      },
    };
    expect(() => Step2FormValuesSchema.parse(valid)).not.toThrow();
  });

  it('rejects missing settings field — composition.generation must NOT enter the form', () => {
    const invalid = {
      products: [],
      background: { kind: 'preset', presetId: null },
      // settings missing
    };
    expect(() => Step2FormValuesSchema.parse(invalid)).toThrow();
  });
});

describe('Step3 voice form mappers', () => {
  const ADVANCED = { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 };
  const SCRIPT = { paragraphs: ['하나', '둘'] };

  const READY_TTS: Voice = {
    source: 'tts',
    voiceId: 'v_minji',
    voiceName: '민지',
    advanced: ADVANCED,
    script: SCRIPT,
    generation: {
      state: 'ready',
      audio: { path: '/p/tts.wav', url: '/u/tts.wav', name: 'tts.wav' },
    },
  };

  it('voiceSliceToFormValues drops generation per variant', () => {
    const fv = voiceSliceToFormValues(READY_TTS);
    expect(fv).toEqual({
      source: 'tts',
      voiceId: 'v_minji',
      voiceName: '민지',
      advanced: ADVANCED,
      script: SCRIPT,
    });
    // The form-shaped object MUST NOT carry generation
    expect((fv as Record<string, unknown>).generation).toBeUndefined();
  });

  it('formValuesToVoiceSlice preserves prev.generation on same-variant edits', () => {
    const fv = voiceSliceToFormValues(READY_TTS);
    // User edits voiceName via form
    const edited = { ...fv, voiceName: '소라' } as typeof fv;
    const next = formValuesToVoiceSlice(edited, READY_TTS);
    expect(next.source).toBe('tts');
    if (next.source !== 'tts') throw new Error('narrow');
    expect(next.voiceName).toBe('소라');
    expect(next.generation).toBe(READY_TTS.generation); // ref preserved
  });

  it('formValuesToVoiceSlice resets generation to idle on cross-variant swap', () => {
    // Was tts (ready), now form switched to clone via setValue
    const cloneForm = {
      source: 'clone' as const,
      sample: { state: 'empty' as const },
      advanced: ADVANCED,
      script: SCRIPT,
    };
    const next = formValuesToVoiceSlice(cloneForm, READY_TTS);
    expect(next.source).toBe('clone');
    if (next.source !== 'clone') throw new Error('narrow');
    expect(next.generation).toEqual({ state: 'idle' });
  });

  it('formValuesToVoiceSlice produces upload variant without generation field', () => {
    const uploadForm = {
      source: 'upload' as const,
      audio: null,
      script: SCRIPT,
    };
    const next = formValuesToVoiceSlice(uploadForm, READY_TTS);
    expect(next.source).toBe('upload');
    expect((next as Record<string, unknown>).generation).toBeUndefined();
  });

  it('Step3FormValuesSchema accepts a clean tts shape', () => {
    const valid = {
      voice: voiceSliceToFormValues(READY_TTS),
    };
    expect(() => Step3FormValuesSchema.parse(valid)).not.toThrow();
  });

  it('voiceSliceToFormValues output never carries generation (the form contract)', () => {
    // Zod's discriminated union members aren't strict, so passing an
    // object with a stray `generation` field doesn't throw on parse.
    // The real guard is the mapper output: voiceSliceToFormValues
    // MUST strip generation per variant so it never re-enters the
    // form and triggers a reset on lifecycle mutations.
    const fv = voiceSliceToFormValues(READY_TTS);
    expect((fv as Record<string, unknown>).generation).toBeUndefined();
  });
});
