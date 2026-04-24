/**
 * useTTSGeneration — ElevenLabs TTS generation for the current
 * wizard voice slice.
 *
 * Reads `voice` from `wizardStore.getState()` at call time (no
 * subscription — keeps the callback identity stable across
 * keystrokes), calls `api.voice.generateVoice`, writes the
 * resulting audio path back to `wizardStore.voice.uploadedAudio`
 * so Step 3's "내 오디오" row picks it up without a follow-up
 * upload step.
 */

import { useCallback, useState } from 'react';
import { generateVoice, type GenerateVoiceInput } from '../api/voice';
import { humanizeError } from '../api/http';
import { useWizardStore } from '../stores/wizardStore';
import { useAbortableRequest } from './useAbortableRequest';

export interface TTSResult {
  audio_path?: string;
  source?: string;
  [key: string]: unknown;
}

export interface UseTTSGenerationReturn {
  result: TTSResult | null;
  isLoading: boolean;
  error: string | null;
  /** Generate TTS from the current wizard voice slice. Returns the
   * parsed response so callers can chain (e.g. kick off the video
   * render with the fresh audio_path) without reading the hook's
   * state on the next render. */
  generate: () => Promise<TTSResult | null>;
  abort: () => void;
}

export function useTTSGeneration(): UseTTSGenerationReturn {
  const [result, setResult] = useState<TTSResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { run, abort } = useAbortableRequest();

  const generate = useCallback(async (): Promise<TTSResult | null> => {
    const { signal, isCurrent } = run();
    const voice = useWizardStore.getState().voice as GenerateVoiceInput['voice'];

    setIsLoading(true);
    setError(null);
    try {
      const res = (await generateVoice({ voice }, { signal })) as TTSResult;
      if (!isCurrent()) return null;
      setResult(res);
      setIsLoading(false);

      // Stash the audio_path on the voice slice so downstream steps
      // (video dispatch) can read it without passing the result
      // object around.
      if (res?.audio_path) {
        useWizardStore.getState().setVoice({
          uploadedAudio: { path: res.audio_path, name: 'tts.wav' },
        });
      }
      return res;
    } catch (err) {
      if (!isCurrent()) return null;
      const name = (err as { name?: string } | null)?.name;
      if (name === 'AbortError') {
        setIsLoading(false);
        return null;
      }
      setIsLoading(false);
      setError(humanizeError(err));
      return null;
    }
  }, [run]);

  return { result, isLoading, error, generate, abort };
}
