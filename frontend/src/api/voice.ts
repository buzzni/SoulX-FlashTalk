/**
 * Step 3 — ElevenLabs voice list + clone + TTS generation.
 *
 * `uploadAudio` lives in `upload.ts`; we re-export it from here so
 * voice-related callers don't have to import from two modules.
 */

import { z } from 'zod';
import { API_BASE, getAuthHeaders, fetchJSON, parseResponse } from './http';
import { assertSize } from './upload';
import { paragraphsToScript } from './mapping';

export interface CallOptions {
  signal?: AbortSignal;
}

export interface VoiceEntry {
  voice_id: string;
  name: string;
  category?: string;
  // Backend returns additional ElevenLabs metadata — callers cherry-pick.
  [key: string]: unknown;
}

const VoiceEntrySchema = z
  .object({
    voice_id: z.string(),
    name: z.string(),
    category: z.string().optional(),
  })
  .passthrough();

const VoiceListResponseSchema = z.object({
  voices: z.array(VoiceEntrySchema),
});

export async function listVoices({ signal }: CallOptions = {}): Promise<{ voices: VoiceEntry[] }> {
  return fetchJSON('/api/elevenlabs/voices', {
    label: '보이스 목록 조회',
    signal,
    schema: VoiceListResponseSchema,
  });
}

export async function cloneVoice(
  sampleFile: Blob,
  name = 'HostStudio 클론',
  { signal }: CallOptions = {},
): Promise<unknown> {
  assertSize(sampleFile);
  const fd = new FormData();
  fd.append('file', sampleFile);
  fd.append('name', name);
  const res = await fetch(`${API_BASE}/api/elevenlabs/clone-voice`, {
    method: 'POST',
    body: fd,
    headers: getAuthHeaders(),
    signal,
  });
  return parseResponse(res, '보이스 클론');
}

export interface GenerateVoiceInput {
  voice: {
    source?: 'tts' | 'clone' | 'upload' | null;
    voiceId?: string | null;
    paragraphs?: string[];
    script?: string;
    stability?: number;
    style?: number;
    similarity?: number;
    speed?: number;
    uploadedAudio?: { key?: string | null };
  };
}

/**
 * Either returns the already-uploaded audio (source='upload' shortcut),
 * or posts to /api/elevenlabs/generate and returns `{key, url, ...}`.
 */
export async function generateVoice(
  { voice }: GenerateVoiceInput,
  { signal }: CallOptions = {},
): Promise<{ key?: string; url?: string; source?: string; [k: string]: unknown }> {
  if (voice.source === 'upload') {
    return { key: voice.uploadedAudio?.key ?? undefined, source: 'upload' };
  }
  // source is narrowed to 'tts' | 'clone' | null | undefined here (the
  // 'upload' branch returned above). Both 'tts' and 'clone' want the v3
  // [breath] separator convention in the script, so pass 'tts' verbatim.
  const script = paragraphsToScript(voice.paragraphs || [voice.script || ''], {
    source: 'tts',
  });
  const body = new FormData();
  if (!voice.voiceId) throw new Error('voice_id가 없어요');
  body.append('voice_id', voice.voiceId);
  body.append('text', script);
  body.append('model_id', 'eleven_v3');
  body.append('stability', String(voice.stability ?? 0.5));
  body.append('style', String(voice.style ?? 0.3));
  body.append('similarity_boost', String(voice.similarity ?? 0.75));
  if (voice.speed && voice.speed !== 1) body.append('speed', String(voice.speed));
  const res = await fetch(`${API_BASE}/api/elevenlabs/generate`, {
    method: 'POST',
    body,
    headers: getAuthHeaders(),
    signal,
  });
  // Backend returns { filename, key, url }. PR-4 collapsed legacy
  // `path`/`storage_key`/`audio_path` shapes onto the canonical pair —
  // useTTSGeneration commits `key` to schema voice.generation.audio.key.
  const json = (await parseResponse(res, '음성 생성')) as Record<string, unknown>;
  return json as { key?: string; url?: string; source?: string; [k: string]: unknown };
}
