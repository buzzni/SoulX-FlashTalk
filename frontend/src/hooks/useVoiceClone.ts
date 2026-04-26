/**
 * useVoiceClone — upload a voice sample to ElevenLabs and receive
 * back a cloned voice_id, driving the schema voice.sample state
 * machine.
 *
 * Phase 2c.4: voice is schema-typed. Clone-mode voices carry a
 * separate `sample` state machine (empty → pending → cloned). This
 * hook is responsible for the network step that flips
 * `pending → cloned` (or stays empty on failure).
 *
 * The `pending` state isn't persisted — the staged File can't survive
 * reload — but it's set transiently so the UI can show the
 * pre-clone preview. `cloned` carries the server-issued voice_id and
 * IS persisted.
 */

import { useCallback, useState } from 'react';
import { cloneVoice } from '../api/voice';
import { humanizeError } from '../api/http';
import { useWizardStore } from '../stores/wizardStore';
import { useAbortableRequest } from './useAbortableRequest';

export interface CloneResult {
  voice_id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface UseVoiceCloneReturn {
  result: CloneResult | null;
  isLoading: boolean;
  error: string | null;
  /** Upload the sample file and clone. `name` is the user-visible
   * label for the cloned voice. The file isn't read off the store
   * (it's a local UI handle); the caller passes it in directly. */
  clone: (sample: Blob, name?: string) => Promise<CloneResult | null>;
  abort: () => void;
}

export function useVoiceClone(): UseVoiceCloneReturn {
  const [result, setResult] = useState<CloneResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { run, abort } = useAbortableRequest();

  const clone = useCallback(
    async (sample: Blob, name = 'HostStudio 클론'): Promise<CloneResult | null> => {
      const { signal, isCurrent } = run();
      setIsLoading(true);
      setError(null);
      try {
        const res = (await cloneVoice(sample, name, { signal })) as CloneResult;
        if (!isCurrent()) return null;
        setResult(res);
        setIsLoading(false);

        if (res?.voice_id) {
          // Transition the clone-mode voice's sample state to `cloned`.
          // Other source modes (tts/upload) shouldn't have this hook
          // invoked — narrow defensively.
          useWizardStore.getState().setVoice((prev) => {
            if (prev.source !== 'clone') return prev;
            return {
              ...prev,
              sample: {
                state: 'cloned',
                voiceId: res.voice_id as string,
                name: res.name ?? name,
              },
            };
          });
        }
        return res;
      } catch (err) {
        if (!isCurrent()) return null;
        const n = (err as { name?: string } | null)?.name;
        if (n === 'AbortError') {
          setIsLoading(false);
          return null;
        }
        setIsLoading(false);
        setError(humanizeError(err));
        return null;
      }
    },
    [run],
  );

  return { result, isLoading, error, clone, abort };
}
