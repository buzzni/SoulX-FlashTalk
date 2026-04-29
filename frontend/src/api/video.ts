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
import { paragraphsToScript, stringifyResolution } from './mapping';
import type { Background, Composition, Host, ImageQuality, ResolutionKey, Voice } from '../wizard/schema';
import { RESOLUTION_META } from '../wizard/schema';
import { isServerAsset } from '../wizard/normalizers';

export interface GenerateVideoInput {
  state: {
    host?: Host | null;
    composition?: Composition | null;
    products?: Array<{ name?: string; path?: string; url?: string }>;
    background?: Background | null;
    voice?: Voice | null;
    resolution: ResolutionKey | null;
    imageQuality?: ImageQuality;
    /** Wizard store stores camelCase; api-mappers maps to wire `playlist_id`. */
    playlistId?: string | null;
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
  // Selected path lives on `generation.selected` for both host and
  // composition when state === 'ready'.
  const hostSelectedPath =
    state.host?.generation?.state === 'ready'
      ? state.host.generation.selected?.key ?? null
      : null;
  const compositeSelectedPath =
    state.composition?.generation?.state === 'ready'
      ? state.composition.generation.selected?.key ?? null
      : null;
  const composite = compositeSelectedPath || hostSelectedPath;
  if (composite) body.append('host_image_path', composite);
  body.append('audio_path', audio.audio_path);
  body.append('audio_source', 'upload');
  const resKey = (state.resolution ?? '448p') as ResolutionKey;
  body.append('resolution', stringifyResolution(RESOLUTION_META[resKey]));
  // Playlist assignment (per docs/playlist-feature-plan.md decision #3).
  // Empty string is the "미지정" signal the backend understands.
  if (state.playlistId) body.append('playlist_id', state.playlistId);

  // Provenance snapshot — see comment in the original api.js. Kept verbatim
  // so the queue entry + manifest shape doesn't change between refactor
  // phases (frontend ProvenanceCard / backend _synthesize_result rely on it).
  const meta = {
    host: hostProvenance(state.host),
    composition: compositionProvenance(state.composition),
    products: (state.products || []).map((p) => ({
      name: p.name || '',
      path: p.path || '',
      url: p.url || '',
    })),
    background: backgroundProvenance(state.background),
    voice: voiceProvenance(state.voice),
    imageQuality: state.imageQuality || '1K',
  };
  body.append('meta', JSON.stringify(meta));

  // Queue label — human-readable row title in the queue dropdown. Priority:
  // explicit script preview > voice id > generic. Prevents every job from
  // showing as "Video generation".
  const voiceProv = meta.voice;
  const scriptPreview = (voiceProv.script || '')
    .replace(/\[breath\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const labelParts: string[] = [];
  if (scriptPreview) {
    labelParts.push(scriptPreview.slice(0, 60));
  } else if (voiceProv.voiceName) {
    labelParts.push(`목소리: ${voiceProv.voiceName}`);
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
    selectedPath: selected?.key ?? null,
    imageUrl: selected?.url ?? null,
    prompt: text?.prompt ?? '',
    negativePrompt: text?.negativePrompt ?? '',
    faceRefPath: image && isServerAsset(image.faceRef) ? (image.faceRef.key ?? null) : null,
    outfitRefPath: image && isServerAsset(image.outfitRef) ? (image.outfitRef.key ?? null) : null,
    outfitText: image?.outfitText ?? '',
    faceStrength: image?.faceStrength ?? null,
    outfitStrength: image?.outfitStrength ?? null,
    temperature: host.temperature,
  };
}

/** Schema-typed Composition → legacy provenance shape. */
function compositionProvenance(c: unknown): {
  selectedSeed: number | null;
  selectedPath: string | null;
  selectedUrl: string | null;
  direction: string;
  shot: string | null;
  angle: string | null;
  temperature: number | null;
} {
  const comp = (c ?? null) as Composition | null;
  if (!comp || !comp.settings || !comp.generation) {
    return {
      selectedSeed: null, selectedPath: null, selectedUrl: null,
      direction: '', shot: null, angle: null, temperature: null,
    };
  }
  const selected =
    comp.generation.state === 'ready' ? comp.generation.selected : null;
  return {
    selectedSeed: selected?.seed ?? null,
    selectedPath: selected?.key ?? null,
    selectedUrl: selected?.url ?? null,
    direction: comp.settings.direction,
    shot: comp.settings.shot,
    angle: comp.settings.angle,
    temperature: comp.settings.temperature,
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
        uploadPath: isServerAsset(b.asset) ? (b.asset.key ?? null) : null,
        imageUrl: isServerAsset(b.asset) ? (b.asset.url ?? null) : null,
      };
    case 'url':
      return { source: 'url', presetId: null, presetLabel: null, prompt: '', uploadPath: null, imageUrl: b.url };
    case 'prompt':
      return { source: 'prompt', presetId: null, presetLabel: null, prompt: b.prompt, uploadPath: null, imageUrl: null };
  }
}

/** Schema-typed `Voice` → the legacy provenance shape (`source`,
 * `voiceId`, `voiceName`, `script`, plus advanced settings). The
 * backend manifest + `ProvenanceCard` consume this exact key set —
 * the schema's tagged-union layout doesn't reach the wire. */
function voiceProvenance(v: unknown): {
  source: string | null;
  voiceId: string | null;
  voiceName: string | null;
  script: string;
  stability: number | null;
  style: number | null;
  similarity: number | null;
  speed: number | null;
} {
  const voice = (v ?? null) as Voice | null;
  if (!voice || typeof voice !== 'object' || !('source' in voice)) {
    return {
      source: null, voiceId: null, voiceName: null, script: '',
      stability: null, style: null, similarity: null, speed: null,
    };
  }
  // Provenance can outrun the 5000-char TTS limit (a long script is
  // legal in upload mode), so use a generous cap rather than the
  // default that throws.
  const script = paragraphsToScript(voice.script.paragraphs, {
    source: voice.source === 'upload' ? 'upload' : 'tts',
    maxChars: Number.MAX_SAFE_INTEGER,
  });
  switch (voice.source) {
    case 'tts':
      return {
        source: 'tts',
        voiceId: voice.voiceId,
        voiceName: voice.voiceName,
        script,
        stability: voice.advanced.stability,
        style: voice.advanced.style,
        similarity: voice.advanced.similarity,
        speed: voice.advanced.speed,
      };
    case 'clone':
      return {
        source: 'clone',
        voiceId: voice.sample.state === 'cloned' ? voice.sample.voiceId : null,
        voiceName: voice.sample.state === 'cloned' ? voice.sample.name : null,
        script,
        stability: voice.advanced.stability,
        style: voice.advanced.style,
        similarity: voice.advanced.similarity,
        speed: voice.advanced.speed,
      };
    case 'upload':
      return {
        source: 'upload',
        voiceId: null,
        voiceName: null,
        script,
        stability: null,
        style: null,
        similarity: null,
        speed: null,
      };
  }
}
