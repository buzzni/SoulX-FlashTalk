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
import type { Background, Host, ResolutionKey } from '../wizard/schema';
import { RESOLUTION_META } from '../wizard/schema';
import { isServerAsset } from '../wizard/normalizers';

export interface GenerateVideoInput {
  state: {
    /** Schema-typed (Phase 2b). Provenance is built via
     * `hostProvenance` below. */
    host?: Host | null;
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
    /** Schema-typed (Phase 2a) — see wizard/schema.ts Background.
     * Provenance snapshot is built via `backgroundProvenance` below. */
    background?: Background | null;
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
    /** Schema-typed (Phase 2c). Just the key — meta lookup via
     * RESOLUTION_META[resKey]. */
    resolution: ResolutionKey | null;
    imageQuality?: string;
    playlist_id?: string | null;
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
  // Phase 2b: host is schema-typed (selectedPath lives on
  // generation.selected when state === 'ready'). Composite path
  // remains legacy until Phase 2c.
  const hostSelectedPath =
    state.host?.generation?.state === 'ready'
      ? state.host.generation.selected?.path ?? null
      : null;
  const composite = state.composition?.selectedPath || hostSelectedPath;
  if (composite) body.append('host_image_path', composite);
  body.append('audio_path', audio.audio_path);
  body.append('audio_source', 'upload');
  // Phase 2c: resolution is just a ResolutionKey now — pull
  // width/height from the canonical meta table.
  const resKey = (state.resolution ?? '448p') as ResolutionKey;
  body.append('resolution', stringifyResolution(RESOLUTION_META[resKey]));
  // Playlist assignment (per docs/playlist-feature-plan.md decision #3).
  // Empty string is the "미지정" signal the backend understands.
  if (state.playlist_id) body.append('playlist_id', state.playlist_id);

  // Provenance snapshot — see comment in the original api.js. Kept verbatim
  // so the queue entry + manifest shape doesn't change between refactor
  // phases (frontend ProvenanceCard / backend _synthesize_result rely on it).
  const meta = {
    host: hostProvenance(state.host),
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
    background: backgroundProvenance(state.background),
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
  if (state.resolution) labelParts.push(RESOLUTION_META[state.resolution].label);
  if (labelParts.length) body.append('queue_label', labelParts.join(' · '));

  const res = await fetch(`${API_BASE}/api/generate`, {
    method: 'POST',
    body,
    headers: getAuthHeaders(),
    signal,
  });
  return parseResponse(res, '영상 생성');
}

/** Schema-typed `Host` → the legacy provenance shape (`mode`,
 * `selectedSeed`, `selectedPath`, `imageUrl`, plus per-mode fields).
 * Keeps the manifest + ProvenanceCard wire format stable. */
function hostProvenance(h: unknown): {
  mode: string;
  selectedSeed: number | null;
  selectedPath: string | null;
  imageUrl: string | null;
  prompt: string;
  negativePrompt: string;
  faceRefPath: string | null;
  outfitRefPath: string | null;
  outfitText: string;
  faceStrength: number | null;
  outfitStrength: number | null;
  temperature: number | null;
} {
  const host = (h ?? null) as Host | null;
  if (!host || typeof host !== 'object' || !('input' in host) || !('generation' in host)) {
    return {
      mode: 'text', selectedSeed: null, selectedPath: null, imageUrl: null,
      prompt: '', negativePrompt: '', faceRefPath: null, outfitRefPath: null,
      outfitText: '', faceStrength: null, outfitStrength: null, temperature: null,
    };
  }
  const selected =
    host.generation.state === 'ready' ? host.generation.selected : null;
  const text = host.input.kind === 'text' ? host.input : null;
  const image = host.input.kind === 'image' ? host.input : null;
  return {
    mode: host.input.kind === 'image' ? 'image' : 'text',
    selectedSeed: selected?.seed ?? null,
    selectedPath: selected?.path ?? null,
    imageUrl: selected?.url ?? null,
    prompt: text?.prompt ?? '',
    negativePrompt: text?.negativePrompt ?? '',
    faceRefPath: image && isServerAsset(image.faceRef) ? image.faceRef.path : null,
    outfitRefPath: image && isServerAsset(image.outfitRef) ? image.outfitRef.path : null,
    outfitText: image?.outfitText ?? '',
    faceStrength: image?.faceStrength ?? null,
    outfitStrength: image?.outfitStrength ?? null,
    temperature: host.temperature,
  };
}

/** Schema-typed `Background` (from wizard/schema) → the legacy
 * provenance shape `{source, presetId, presetLabel, prompt,
 * uploadPath, imageUrl}` that the backend's _synthesize_result + the
 * frontend's ProvenanceCard expect. Keeps wire format stable while the
 * UI layer uses the typed model. */
function backgroundProvenance(bg: unknown): {
  source: string | null;
  presetId: string | null;
  presetLabel: string | null;
  prompt: string;
  uploadPath: string | null;
  imageUrl: string | null;
} {
  const b = (bg ?? null) as Background | null;
  if (!b || typeof b !== 'object' || !('kind' in b)) {
    return { source: null, presetId: null, presetLabel: null, prompt: '', uploadPath: null, imageUrl: null };
  }
  switch (b.kind) {
    case 'preset':
      return { source: 'preset', presetId: b.presetId, presetLabel: null, prompt: '', uploadPath: null, imageUrl: null };
    case 'upload':
      return {
        source: 'upload',
        presetId: null,
        presetLabel: null,
        prompt: '',
        uploadPath: isServerAsset(b.asset) ? b.asset.path : null,
        imageUrl: isServerAsset(b.asset) ? (b.asset.url ?? null) : null,
      };
    case 'url':
      return { source: 'url', presetId: null, presetLabel: null, prompt: '', uploadPath: null, imageUrl: b.url };
    case 'prompt':
      return { source: 'prompt', presetId: null, presetLabel: null, prompt: b.prompt, uploadPath: null, imageUrl: null };
  }
}
