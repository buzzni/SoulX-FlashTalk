/**
 * useVoiceClone — upload a voice sample to ElevenLabs and receive
 * back a cloned voice_id.
 *
 * Written to `wizardStore.voice.cloneSample` on success so the
 * voice picker's "내 목소리" row shows the cloned voice without
 * a re-fetch.
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
   * label for the cloned voice. */
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
          useWizardStore.getState().setVoice({
            cloneSample: { voiceId: res.voice_id, name: res.name ?? name },
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
