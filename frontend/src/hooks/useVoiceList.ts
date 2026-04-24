/**
 * useVoiceList — fetch the ElevenLabs voice catalogue once per
 * mount (or on explicit refresh), cache in state.
 *
 * Not tied to wizardStore — the list is read-only reference data
 * that doesn't belong in persisted state. Fetches abort cleanly if
 * the component unmounts mid-request.
 */

import { useCallback, useEffect, useState } from 'react';
import { listVoices, type VoiceEntry } from '../api/voice';
import { humanizeError } from '../api/http';
import { useAbortableRequest } from './useAbortableRequest';

export interface UseVoiceListReturn {
  voices: VoiceEntry[];
  isLoading: boolean;
  error: string | null;
  /** Re-fetch the voice list. Aborts any in-flight request. */
  refresh: () => Promise<void>;
}

export function useVoiceList(): UseVoiceListReturn {
  const [voices, setVoices] = useState<VoiceEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { run } = useAbortableRequest();

  const refresh = useCallback(async () => {
    const { signal, isCurrent } = run();
    setIsLoading(true);
    setError(null);
    try {
      const res = await listVoices({ signal });
      if (!isCurrent()) return;
      setVoices(res.voices ?? []);
      setIsLoading(false);
    } catch (err) {
      if (!isCurrent()) return;
      const name = (err as { name?: string } | null)?.name;
      if (name === 'AbortError') {
        setIsLoading(false);
        return;
      }
      setIsLoading(false);
      setError(humanizeError(err));
    }
  }, [run]);

  // Auto-fetch once on mount.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { voices, isLoading, error, refresh };
}
