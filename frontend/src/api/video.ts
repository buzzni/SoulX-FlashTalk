/**
 * Final video dispatch — POST /api/generate.
 *
 * Takes the full wizard `state` (host + composition + products +
 * background + voice + resolution + imageQuality) plus the already-
 * produced audio, builds the backend payload, and returns the queued
 * task record.
 *
 * The `meta` snapshot attached here is what the result manifest and
 * ProvenanceCard read from later — it captures the *actual* state at
 * dispatch so post-hoc UIs don't drift with the current wizard.
 */

import { API_BASE, getAuthHeaders, parseResponse } from './http';
import { stringifyResolution } from './mapping';

export interface GenerateVideoInput {
  state: {
    host?: {
      mode?: string;
      selectedSeed?: number | null;
      selectedPath?: string | null;
      imageUrl?: string | null;
      prompt?: string;
      negativePrompt?: string;
      faceRefPath?: string | null;
      outfitRefPath?: string | null;
      outfitText?: string;
      faceStrength?: number | null;
      outfitStrength?: number | null;
      temperature?: number | null;
    } | null;
    composition?: {
      selectedSeed?: number | null;
      selectedPath?: string | null;
      selectedUrl?: string | null;
      direction?: string;
      shot?: string | null;
      angle?: string | null;
      temperature?: number | null;
    } | null;
    products?: Array<{ name?: string; path?: string; url?: string }>;
    background?: {
      source?: string | null;
      preset?: { id?: string; label?: string } | string | null;
      prompt?: string;
      uploadPath?: string | null;
      imageUrl?: string | null;
    } | null;
    voice?: {
      source?: string | null;
      voiceId?: string | null;
      voiceName?: string | null;
      script?: string;
      stability?: number | null;
      style?: number | null;
      similarity?: number | null;
      speed?: number | null;
    } | null;
    resolution: { width?: number; height?: number; label?: string };
    imageQuality?: string;
  };
  audio: { audio_path: string };
}

export interface CallOptions {
  signal?: AbortSignal;
}

export async function generateVideo(
  { state, audio }: GenerateVideoInput,
  { signal }: CallOptions = {},
): Promise<{ task_id: string; [key: string]: unknown }> {
  // /api/generate accepts: audio_source, host_image_path, audio_path, script_text,
  // voice_id, stability/similarity_boost/style, prompt, seed, cpu_offload, resolution,
  // scene_prompt, reference_image_paths. Anything else is silently dropped.
  //
  // host_image_path here is the FINAL composite frame (Step 2 selection) — that's
  // the single frame FlashTalk animates. The Step 1 host-only image is not sent.
  const body = new FormData();
  const composite = state.composition?.selectedPath || state.host?.selectedPath;
  if (composite) body.append('host_image_path', composite);
  body.append('audio_path', audio.audio_path);
  body.append('audio_source', 'upload');
  body.append('resolution', stringifyResolution(state.resolution));

  // Provenance snapshot — see comment in the original api.js. Kept verbatim
  // so the queue entry + manifest shape doesn't change between refactor
  // phases (frontend ProvenanceCard / backend _synthesize_result rely on it).
  const meta = {
    host: {
      mode: state.host?.mode ?? 'text',
      selectedSeed: state.host?.selectedSeed ?? null,
      selectedPath: state.host?.selectedPath ?? null,
      imageUrl: state.host?.imageUrl ?? null,
      prompt: state.host?.prompt ?? '',
      negativePrompt: state.host?.negativePrompt ?? '',
      faceRefPath: state.host?.faceRefPath ?? null,
      outfitRefPath: state.host?.outfitRefPath ?? null,
      outfitText: state.host?.outfitText ?? '',
      faceStrength: state.host?.faceStrength ?? null,
      outfitStrength: state.host?.outfitStrength ?? null,
      temperature: state.host?.temperature ?? null,
    },
    composition: {
      selectedSeed: state.composition?.selectedSeed ?? null,
      selectedPath: state.composition?.selectedPath ?? null,
      selectedUrl: state.composition?.selectedUrl ?? null,
      direction: state.composition?.direction ?? '',
      shot: state.composition?.shot ?? null,
      angle: state.composition?.angle ?? null,
      temperature: state.composition?.temperature ?? null,
    },
    products: (state.products || []).map((p) => ({
      name: p.name || '',
      path: p.path || '',
      url: p.url || '',
    })),
    background: {
      source: state.background?.source || null,
      presetId:
        (typeof state.background?.preset === 'object' && state.background.preset?.id) ||
        (typeof state.background?.preset === 'string' ? state.background.preset : null),
      presetLabel:
        typeof state.background?.preset === 'object' ? state.background.preset?.label || null : null,
      prompt: state.background?.prompt || '',
      uploadPath: state.background?.uploadPath || null,
      imageUrl: state.background?.imageUrl || null,
    },
    voice: {
      source: state.voice?.source || null,
      voiceId: state.voice?.voiceId || null,
      voiceName: state.voice?.voiceName || null,
      script: state.voice?.script || '',
      stability: state.voice?.stability ?? null,
      style: state.voice?.style ?? null,
      similarity: state.voice?.similarity ?? null,
      speed: state.voice?.speed ?? null,
    },
    imageQuality: state.imageQuality || '1K',
  };
  body.append('meta', JSON.stringify(meta));

  // Queue label — human-readable row title in the queue dropdown. Priority:
  // explicit script preview > voice id > generic. Prevents every job from
  // showing as "Video generation".
  const scriptPreview = (state.voice?.script || '')
    .replace(/\[breath\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const labelParts: string[] = [];
  if (scriptPreview) {
    labelParts.push(scriptPreview.slice(0, 60));
  } else if (state.voice?.voiceName) {
    labelParts.push(`목소리: ${state.voice.voiceName}`);
  }
  if (state.resolution?.label) labelParts.push(state.resolution.label);
  if (labelParts.length) body.append('queue_label', labelParts.join(' · '));

  const res = await fetch(`${API_BASE}/api/generate`, {
    method: 'POST',
    body,
    headers: getAuthHeaders(),
    signal,
  });
  return parseResponse(res, '영상 생성');
}
