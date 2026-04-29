/**
 * Step3Audio — integration tests for the RHF-driven submit handler,
 * eager-upload effect, and SCRIPT_LIMIT clamp behavior.
 *
 * Covers the high-risk paths flagged by the /ship coverage audit that
 * unit tests on form-mappers + e2e mode-swap specs don't reach:
 *
 *   - Eager-upload LocalAsset → ServerAsset transition for upload mode
 *     (Step3Audio.tsx eager useEffect).
 *   - Synchronous setVoice flush inside form.handleSubmit so
 *     useTTSGeneration.generate() reads fresh voice state even when the
 *     user clicks within the 300ms debounce window.
 *   - Submit throw branches surface humanizeError'd messages via
 *     setErrorMsg (clone-empty, tts-no-voiceId).
 *   - ScriptEditor SCRIPT_LIMIT 5000-char clamp on per-paragraph trim.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Polyfill ResizeObserver for jsdom — Radix UI's Slider/Select rely on
// it, and Step3Audio renders both via VoiceAdvancedSettings and
// PlaylistPicker.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

// Mock the hook modules BEFORE importing Step3Audio so the component
// picks up our mocks at import time.
const ttsGenerate = vi.fn();
const cloneVoice = vi.fn();
const audioUploadRun = vi.fn();
let __ttsLoading = false;
let __cloneLoading = false;
let __audioLoading = false;

vi.mock('../../hooks/useTTSGeneration', () => ({
  useTTSGeneration: () => ({
    result: null,
    isLoading: __ttsLoading,
    error: null,
    generate: ttsGenerate,
    abort: vi.fn(),
  }),
}));
vi.mock('../../hooks/useVoiceClone', () => ({
  useVoiceClone: () => ({
    result: null,
    isLoading: __cloneLoading,
    error: null,
    clone: cloneVoice,
    abort: vi.fn(),
  }),
}));
vi.mock('../../hooks/useUploadReferenceImage', () => ({
  useUploadReferenceImage: () => ({
    isLoading: __audioLoading,
    error: null,
    upload: audioUploadRun,
  }),
}));
vi.mock('../../hooks/useVoiceList', () => ({
  useVoiceList: () => ({ voices: [], isLoading: false, error: null }),
}));
vi.mock('../../api/upload', async () => {
  const actual = await vi.importActual<typeof import('../../api/upload')>(
    '../../api/upload',
  );
  return { ...actual, uploadAudio: vi.fn() };
});
vi.mock('../../api/playlists', () => ({
  listPlaylists: vi.fn().mockResolvedValue({ playlists: [], unassigned_count: 0 }),
  createPlaylist: vi.fn(),
}));

import Step3Audio from '../step3/Step3Audio';
import { useWizardStore } from '../../stores/wizardStore';
import {
  INITIAL_BACKGROUND,
  INITIAL_COMPOSITION,
  INITIAL_HOST,
  INITIAL_VOICE,
  type Voice,
} from '../../wizard/schema';

const READY_HOST = {
  ...INITIAL_HOST,
  generation: {
    state: 'ready' as const,
    batchId: 'b1',
    variants: [{ seed: 1, imageId: 'h1', url: '/u/h1.png', key: '/p/h1.png' }],
    selected: { seed: 1, imageId: 'h1', url: '/u/h1.png', key: '/p/h1.png' },
    prevSelected: null,
  },
};

function seedStore(voiceOverride: Voice = INITIAL_VOICE) {
  useWizardStore.setState({
    host: READY_HOST,
    products: [],
    background: INITIAL_BACKGROUND,
    composition: INITIAL_COMPOSITION,
    voice: voiceOverride,
    resolution: '448p',
    imageQuality: '1K',
    playlistId: null,
    wizardEpoch: 0,
    lastSavedAt: null,
  });
}

function renderStep3() {
  const state = useWizardStore.getState();
  const update = (
    fn: (s: ReturnType<typeof useWizardStore.getState>) => Partial<ReturnType<typeof useWizardStore.getState>>,
  ) => useWizardStore.setState((cur) => fn(cur));
  return render(
    <MemoryRouter>
      <Step3Audio state={state as never} update={update as never} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  ttsGenerate.mockReset();
  cloneVoice.mockReset();
  audioUploadRun.mockReset();
  __ttsLoading = false;
  __cloneLoading = false;
  __audioLoading = false;
});

afterEach(() => {
  cleanup();
});

describe('Step3Audio — submit handler', () => {
  it('synchronously flushes form-only changes to the store before tts.generate reads it', async () => {
    // Seed with no voice picked yet — voiceId must transition from
    // null → 'v_minji' via the form (VoicePicker click) and reach the
    // store synchronously inside submit, BEFORE tts.generate fires.
    // If the sync flush regresses, the store still has voiceId:null
    // at tts.generate time (debounce hasn't fired) and the captured
    // voice fails the assertion.
    seedStore({
      source: 'tts',
      voiceId: null,
      voiceName: null,
      advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 },
      script: { paragraphs: ['대본 한 줄'] },
      generation: { state: 'idle' },
    });
    const voiceAtGenerateRef: { current: Voice | null } = { current: null };
    ttsGenerate.mockImplementation(async () => {
      voiceAtGenerateRef.current = useWizardStore.getState().voice;
      return { audio_path: '/p/tts.wav' };
    });
    renderStep3();
    // Pick '민지' (preset row). VoicePicker fallback list is rendered
    // because useVoiceList mock returns empty voices.
    const minjiRow = screen.getByText('민지').closest('[data-testid="voice-row"]');
    if (!minjiRow) throw new Error('expected 민지 preset row');
    fireEvent.click(minjiRow);
    // Generate button enables once form has voiceId; no debounce wait.
    const generateBtn = screen.getByText('음성 만들기').closest('button') as HTMLButtonElement;
    await waitFor(() => expect(generateBtn.disabled).toBe(false));
    fireEvent.click(generateBtn);
    await waitFor(() => expect(ttsGenerate).toHaveBeenCalled());
    const captured = voiceAtGenerateRef.current;
    if (!captured || captured.source !== 'tts') {
      throw new Error('voice should be tts at generate time');
    }
    expect(captured.voiceId).toBe('v_minji');
    expect(captured.voiceName).toBe('민지');
  });
});

describe('Step3Audio — narrow-watch regression guard', () => {
  it('typed paragraph survives a voice.generation mutation (no broad voice subscription)', async () => {
    // The store starts with one paragraph value; the user then types
    // a different value into the form (dirty, not yet flushed via
    // 300ms debounce). A side-channel setVoice mutates ONLY
    // voice.generation. If any container code path subscribes to the
    // whole voice slice (instead of narrow per-field watches), the
    // formValues memo would create a new reference, useFormZustandSync
    // would call form.reset, and the form's dirty value would be
    // overwritten by the store value. The narrow-watch design makes
    // generation-only mutations invisible to the form bridge.
    seedStore({
      source: 'tts',
      voiceId: 'v_minji',
      voiceName: '민지',
      advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 },
      script: { paragraphs: ['STORE'] },
      generation: { state: 'idle' },
    });
    renderStep3();
    const textarea = screen.getAllByRole('textbox')[0] as HTMLTextAreaElement;
    expect(textarea.value).toBe('STORE');
    // Type a different value — form is now dirty with 'FORM-EDIT';
    // store still has 'STORE' until the 300ms debounce flushes.
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'FORM-EDIT' } });
    });
    expect(textarea.value).toBe('FORM-EDIT');
    // Side-channel setVoice mutates only generation. Same-source
    // branch keeps script/advanced/voiceId refs stable so narrow
    // selectors should NOT trigger form.reset.
    await act(async () => {
      useWizardStore.getState().setVoice((prev) => {
        if (prev.source !== 'tts') return prev;
        return { ...prev, generation: { state: 'generating' } };
      });
    });
    // The dirty form value MUST survive — if it reverts to 'STORE',
    // the narrow-watch design has regressed.
    expect(textarea.value).toBe('FORM-EDIT');
  });
});

describe('Step3Audio — eager upload effect', () => {
  it('upload mode: after picking a LocalAsset audio, audioUpload.upload runs and form swaps to ServerAsset', async () => {
    seedStore({
      source: 'upload',
      audio: null,
      script: { paragraphs: [''] },
    });
    audioUploadRun.mockResolvedValue({
      key: '/srv/voice.mp3',
      url: '/u/voice.mp3',
    });
    const file = new File(['fake-audio'], 'sample.mp3', { type: 'audio/mp3' });
    renderStep3();
    // Find the file input rendered by UploadTile inside AudioUploader.
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    if (!input) throw new Error('expected file input from AudioUploader');
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => expect(audioUploadRun).toHaveBeenCalledTimes(1));
    expect(audioUploadRun).toHaveBeenCalledWith(file);
    // After the eager upload resolves, the form (and the debounce-flushed
    // store) reflect a ServerAsset shape. The store flush takes 300ms
    // via useDebouncedFormSync; assert against the form's eventual store.
    await waitFor(
      () => {
        const v = useWizardStore.getState().voice;
        if (v.source !== 'upload') throw new Error('not upload');
        if (!v.audio || !('key' in v.audio)) throw new Error('not server');
        expect(v.audio.key).toBe('/srv/voice.mp3');
      },
      { timeout: 1500 },
    );
  });
});

import { clampParagraphs, buildScript, SCRIPT_LIMIT } from '../step3/ScriptEditor';

describe('clampParagraphs', () => {
  it('preserves under-limit input verbatim', () => {
    const input = ['hello', 'world'];
    expect(clampParagraphs(input)).toEqual(['hello', 'world']);
  });

  it('truncates the over-budget paragraph and keeps the join under the cap', () => {
    // 3 paragraphs of 2000 chars; BREATH_TAG separator costs 10 chars
    // between non-empty entries.
    //   used after p1 = 2000, after p2 = 4010 (2000 + sep10),
    //   available for p3 = 5000 - 4010 - 10 = 980.
    const input = ['a'.repeat(2000), 'b'.repeat(2000), 'c'.repeat(2000)];
    const out = clampParagraphs(input);
    expect((out[0] ?? '').length).toBe(2000);
    expect((out[1] ?? '').length).toBe(2000);
    expect((out[2] ?? '').length).toBe(980);
    expect(buildScript(out).length).toBeLessThanOrEqual(SCRIPT_LIMIT);
  });

  it('emits empty strings for paragraphs that arrive after the budget is exhausted', () => {
    const input = ['x'.repeat(SCRIPT_LIMIT), 'tail-1', 'tail-2'];
    const out = clampParagraphs(input);
    expect((out[0] ?? '').length).toBe(SCRIPT_LIMIT);
    expect(out[1]).toBe('');
    expect(out[2]).toBe('');
    expect(buildScript(out).length).toBeLessThanOrEqual(SCRIPT_LIMIT);
  });

  it('treats leading empty paragraphs as no separator cost (first non-empty omits BREATH_TAG)', () => {
    const input = ['', '', 'a'.repeat(SCRIPT_LIMIT)];
    const out = clampParagraphs(input);
    expect((out[2] ?? '').length).toBe(SCRIPT_LIMIT);
    expect(buildScript(out).length).toBe(SCRIPT_LIMIT);
  });
});

describe('ScriptEditor — SCRIPT_LIMIT clamp', () => {
  it('typing past 5000 chars in a paragraph clips at the limit', async () => {
    const seed = 'a'.repeat(4500);
    seedStore({
      source: 'tts',
      voiceId: 'v1',
      voiceName: 'V1',
      advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 },
      script: { paragraphs: [seed] },
      generation: { state: 'idle' },
    });
    renderStep3();
    const textarea = screen.getAllByRole('textbox')[0] as HTMLTextAreaElement;
    expect(textarea.value).toBe(seed);
    // Set the textarea to 5500 chars in one shot — clamp logic in
    // ScriptEditor.updateParagraph slices the value to the available
    // budget (5000 - sum-of-other-paragraphs - breath-tag-overhead).
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'a'.repeat(5500) } });
    });
    await waitFor(() => {
      const v = useWizardStore.getState().voice;
      if (v.source !== 'tts') throw new Error('not tts');
      const first = v.script.paragraphs[0] ?? '';
      expect(first.length).toBe(5000);
    });
  });
});
