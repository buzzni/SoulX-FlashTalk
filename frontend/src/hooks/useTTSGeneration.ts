/**
 * useTTSGeneration — ElevenLabs TTS generation driving the schema
 * voice.generation state machine.
 *
 * Phase 2c.4: voice is schema-typed. The hook reads `voice` from the
 * store at call time (no subscription — keeps the callback identity
 * stable across keystrokes), maps to the API request via
 * `toVoiceGenerateRequest`, then transitions
 *
 *   idle → generating → (ready | failed)
 *
 * on the store's voice.generation field. Upload-mode voices have no
 * generation step — calling generate() in upload mode is a no-op that
 * surfaces an error.
 */

import { useCallback, useState } from 'react';
import { generateVoice } from '../api/voice';
import { humanizeError } from '../api/http';
import { useWizardStore } from '../stores/wizardStore';
import { useAbortableRequest } from './useAbortableRequest';
import { toVoiceGenerateRequest } from '../wizard/api-mappers';
import type { ServerAsset } from '../wizard/schema';

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
    const voice = useWizardStore.getState().voice;

    if (voice.source === 'upload') {
      // Upload mode bypasses TTS entirely — caller shouldn't reach
      // this. Surface a clean error rather than silently no-op.
      const msg = '내 녹음 모드에서는 음성을 생성할 수 없어요';
      setError(msg);
      return null;
    }

    setIsLoading(true);
    setError(null);

    // Transition the store's voice.generation to `generating`. Phase
    // 2c.4: this is the persisted side-effect at stream start;
    // selection of voiceId / sample / advanced settings are user
    // edits committed earlier.
    useWizardStore.getState().setVoice((prev) => {
      if (prev.source === 'upload') return prev; // narrowed-out
      return { ...prev, generation: { state: 'generating' } };
    });

    try {
      const req = toVoiceGenerateRequest(voice);
      const res = (await generateVoice(req, { signal })) as TTSResult;
      if (!isCurrent()) return null;
      setResult(res);
      setIsLoading(false);

      // Commit the result to voice.generation. Audio path is the
      // canonical persisted identifier; URL is best-effort (the
      // backend may or may not return one).
      const audio: ServerAsset = {
        key: res.audio_path ?? '',
        url: typeof res.url === 'string' ? res.url : undefined,
        name: 'tts.wav',
      };
      if (audio.key) {
        useWizardStore.getState().setVoice((prev) => {
          if (prev.source === 'upload') return prev;
          return { ...prev, generation: { state: 'ready', audio } };
        });
      }
      return res;
    } catch (err) {
      if (!isCurrent()) return null;
      const name = (err as { name?: string } | null)?.name;
      if (name === 'AbortError') {
        setIsLoading(false);
        // Abort returns generation to idle so the next attempt starts clean.
        useWizardStore.getState().setVoice((prev) => {
          if (prev.source === 'upload') return prev;
          return { ...prev, generation: { state: 'idle' } };
        });
        return null;
      }
      setIsLoading(false);
      const msg = humanizeError(err);
      setError(msg);
      useWizardStore.getState().setVoice((prev) => {
        if (prev.source === 'upload') return prev;
        return { ...prev, generation: { state: 'failed', error: msg } };
      });
      return null;
    }
  }, [run]);

  return { result, isLoading, error, generate, abort };
}
