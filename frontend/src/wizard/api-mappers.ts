/**
 * Wizard schema → backend request payload mappers.
 *
 * The single place that constructs API request bodies. UI never calls
 * fetch directly with hand-built objects — it calls one of these
 * mappers, then hands the typed result to a function in `src/api/*`.
 *
 * If a schema field needs to be in a backend payload, the mapping
 * happens here. If a payload field appears, the schema state must
 * support it. Anything else is a bug in this file.
 */

import type { HostGenerateInput } from '../api/host';
import type { CompositeInput } from '../api/composite';
import type { GenerateVoiceInput } from '../api/voice';
import { isLocalAsset, isServerAsset } from './normalizers';
import {
  RESOLUTION_META,
  type Background,
  type Composition,
  type Host,
  type HostBuilder,
  type ImageQuality,
  type Products,
  type ResolutionKey,
  type Voice,
} from './schema';

// ────────────────────────────────────────────────────────────────────
// Host
// ────────────────────────────────────────────────────────────────────

/**
 * Schema Host → /api/host/generate request payload.
 *
 * The backend's HostGenerateInput is a "wide-open optional" interface
 * because it serves both modes. This mapper picks the right fields
 * per the schema's `input.kind` discriminator.
 */
export function toHostGenerateRequest(
  host: Host,
  imageQuality: ImageQuality,
  seeds?: number[],
): HostGenerateInput {
  const base: HostGenerateInput = {
    temperature: host.temperature,
    imageSize: imageQuality,
  };
  if (seeds && seeds.length > 0) base._seeds = seeds;

  if (host.input.kind === 'text') {
    return {
      ...base,
      mode: 'text',
      prompt: host.input.prompt,
      builder: emptyToNull(host.input.builder),
      negativePrompt: host.input.negativePrompt,
      extraPrompt: host.input.extraPrompt,
    };
  }

  // image mode — pass server paths only (uploads must complete first)
  const faceRefPath = isServerAsset(host.input.faceRef) ? host.input.faceRef.path : null;
  const outfitRefPath = isServerAsset(host.input.outfitRef) ? host.input.outfitRef.path : null;
  const mode: HostGenerateInput['mode'] =
    faceRefPath && outfitRefPath ? 'face-outfit' : faceRefPath ? 'style-ref' : 'text';

  return {
    ...base,
    mode,
    faceRefPath,
    outfitRefPath,
    faceStrength: host.input.faceStrength,
    outfitStrength: host.input.outfitStrength,
    outfitText: host.input.outfitText,
    extraPrompt: host.input.extraPrompt,
    // host.ts also wants raw refs to *test* their existence — passing
    // truthy server-asset proxies satisfies that without leaking File handles.
    faceRef: host.input.faceRef ? {} : undefined,
    outfitRef: host.input.outfitRef ? {} : undefined,
  };
}

function emptyToNull(b: HostBuilder): HostBuilder | null {
  return Object.keys(b).length === 0 ? null : b;
}

// ────────────────────────────────────────────────────────────────────
// Composite
// ────────────────────────────────────────────────────────────────────

export interface CompositeMapperInput {
  host: Host;
  products: Products;
  background: Background;
  composition: Composition;
  imageQuality: ImageQuality;
}

/**
 * Schema state → /api/composite/generate request payload.
 *
 * The backend `CompositeInput` shape is { host, products, background,
 * composition, imageSize }. We pick the right fields per slice
 * discriminator, dropping everything that's UI-only.
 */
export function toCompositeRequest(input: CompositeMapperInput): CompositeInput {
  const hostSelected =
    input.host.generation.state === 'ready' ? input.host.generation.selected : null;

  return {
    host: {
      selectedPath: hostSelected?.path ?? null,
    },
    products: input.products
      .map((p) => {
        if (p.source.kind === 'uploaded') {
          return { id: p.id, name: p.name, path: p.source.asset.path };
        }
        if (p.source.kind === 'url') {
          return { id: p.id, name: p.name, url: p.source.url };
        }
        return null;
      })
      .filter((p): p is NonNullable<typeof p> => p !== null),
    background: backgroundToCompositeBg(input.background),
    composition: {
      direction: input.composition.settings.direction,
      shot: input.composition.settings.shot,
      angle: input.composition.settings.angle,
      temperature: input.composition.settings.temperature,
    },
    imageSize: input.imageQuality,
  } as unknown as CompositeInput;
}

function backgroundToCompositeBg(bg: Background) {
  switch (bg.kind) {
    case 'preset':
      return { source: 'preset', preset: bg.presetId };
    case 'upload':
      return {
        source: 'upload',
        uploadPath: isServerAsset(bg.asset) ? bg.asset.path : null,
        // Local file isn't valid here — caller must upload first.
      };
    case 'url':
      return { source: 'url', url: bg.url };
    case 'prompt':
      return { source: 'prompt', prompt: bg.prompt };
  }
}

// ────────────────────────────────────────────────────────────────────
// Voice
// ────────────────────────────────────────────────────────────────────

/**
 * Schema Voice → /api/voice/generate request payload (TTS modes only).
 * `upload` mode bypasses TTS entirely — caller checks source !==
 * 'upload' before calling this.
 */
export function toVoiceGenerateRequest(voice: Voice): GenerateVoiceInput {
  if (voice.source === 'upload') {
    throw new Error('toVoiceGenerateRequest: upload-mode voice has no TTS request');
  }

  const voiceId =
    voice.source === 'clone' && voice.sample.state === 'cloned'
      ? voice.sample.voiceId
      : voice.source === 'tts'
        ? voice.voiceId
        : null;

  // generateVoice() reads `paragraphs` and joins them via
  // paragraphsToScript with the right separator, so we don't pre-join
  // here. (A prior version did, with the wrong separator — and the
  // result was overridden anyway.)
  return {
    voice: {
      source: voice.source,
      voiceId: voiceId ?? null,
      paragraphs: voice.script.paragraphs,
      speed: voice.advanced.speed,
      stability: voice.advanced.stability,
      style: voice.advanced.style,
      similarity: voice.advanced.similarity,
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Render (final video assembly)
// ────────────────────────────────────────────────────────────────────

export interface RenderRequest {
  composite_path: string;
  audio_path: string;
  subtitle: string;
  width: number;
  height: number;
  resolution_key: ResolutionKey;
  playlist_id: string | null;
}

/**
 * Build the final /api/generate (video render) payload from the full
 * wizard state. Returns null if anything required is missing — the
 * caller (RenderDispatchPage) gates on that.
 */
export function toRenderRequest(args: {
  composition: Composition;
  voice: Voice;
  resolution: ResolutionKey;
  playlistId: string | null;
}): RenderRequest | null {
  const compositeSelected =
    args.composition.generation.state === 'ready'
      ? args.composition.generation.selected
      : null;
  if (!compositeSelected) return null;

  const audioPath = (() => {
    if (args.voice.source === 'upload') {
      return isServerAsset(args.voice.audio) ? args.voice.audio.path : null;
    }
    return args.voice.generation.state === 'ready' ? args.voice.generation.audio.path : null;
  })();
  if (!audioPath) return null;

  const subtitle = args.voice.script.paragraphs.join('\n');
  const meta = RESOLUTION_META[args.resolution];

  return {
    composite_path: compositeSelected.path,
    audio_path: audioPath,
    subtitle,
    width: meta.width,
    height: meta.height,
    resolution_key: args.resolution,
    playlist_id: args.playlistId,
  };
}

// silence linter for unused isLocalAsset import — re-exported for symmetry
void isLocalAsset;
