/**
 * Wizard schema normalizers.
 *
 *   migrateLegacy(raw)  — read a pre-schema persisted blob and produce
 *                          a typed WizardState. Runs once on hydrate.
 *   toPersistable(state) — strip non-serializable fields (File handles,
 *                          blob: URLs) before localStorage write.
 *   isLocalAsset / isServerAsset — narrow the union types.
 *
 * Pure functions — no React, no store reads. Easy to unit-test.
 */

import {
  INITIAL_BACKGROUND,
  INITIAL_COMPOSITION,
  INITIAL_HOST,
  INITIAL_VOICE,
  INITIAL_WIZARD_STATE,
  RESOLUTION_META,
  type Background,
  type Composition,
  type CompositionAngle,
  type CompositionGeneration,
  type CompositionShot,
  type CompositionVariant,
  type Host,
  type HostBuilder,
  type HostGeneration,
  type HostInput,
  type HostVariant,
  type ImageQuality,
  type LocalAsset,
  type Product,
  type ProductSource,
  type Products,
  type ResolutionKey,
  type Script,
  type ServerAsset,
  type Voice,
  type VoiceAdvanced,
  type VoiceCloneSample,
  type VoiceGeneration,
  type WizardState,
} from './schema';

// ────────────────────────────────────────────────────────────────────
// Type narrowers
// ────────────────────────────────────────────────────────────────────

export function isLocalAsset(a: ServerAsset | LocalAsset | null | undefined): a is LocalAsset {
  return !!a && 'file' in a && a.file instanceof File;
}

export function isServerAsset(a: ServerAsset | LocalAsset | null | undefined): a is ServerAsset {
  return !!a && !isLocalAsset(a) && typeof (a as ServerAsset).path === 'string';
}

function isTransientUrl(u: unknown): boolean {
  return typeof u === 'string' && (u.startsWith('blob:') || u.startsWith('data:'));
}

// ────────────────────────────────────────────────────────────────────
// Persistence — strip everything that can't survive a page reload
// ────────────────────────────────────────────────────────────────────

/** Drop LocalAsset (File + blob: URL); keep ServerAsset (has a real path). */
function persistAsset(a: ServerAsset | LocalAsset | null | undefined): ServerAsset | null {
  if (!a) return null;
  if (isServerAsset(a)) {
    return {
      path: a.path,
      url: isTransientUrl(a.url) ? undefined : a.url,
      name: a.name,
    };
  }
  return null;
}

/** Drop transient-only fields from a Host. Exported for per-slice
 * persisters (wizardStore.ts) — Phase 2b. */
export function persistHost(host: Host): Host {
  // Drop transient input refs (File-typed); keep the schema input shape.
  const input: HostInput =
    host.input.kind === 'text'
      ? host.input
      : {
          ...host.input,
          faceRef: persistAsset(host.input.faceRef),
          outfitRef: persistAsset(host.input.outfitRef),
        };

  // Variants survive (they live on the server). Selected survives.
  // Streaming/failed states reset on reload — the SSE stream is gone.
  const generation: HostGeneration =
    host.generation.state === 'streaming' || host.generation.state === 'failed'
      ? { state: 'idle' }
      : host.generation;

  return { ...host, input, generation };
}

function persistProduct(p: Product): Product {
  const source: ProductSource =
    p.source.kind === 'localFile'
      ? { kind: 'empty' } // transient — nothing to persist
      : p.source;
  return { ...p, source };
}

/** Drop transient-only fields from a Background. Exported so per-slice
 * persisters (wizardStore.ts) can reuse without going through the full
 * WizardState wrapper. */
export function persistBackground(bg: Background): Background {
  if (bg.kind === 'upload') {
    return { kind: 'upload', asset: persistAsset(bg.asset) };
  }
  return bg;
}

/** Drop transient generation states (streaming/failed → idle) on
 * persist. Exported for per-slice persisters in wizardStore — Phase
 * 2c.3. */
export function persistComposition(comp: Composition): Composition {
  const generation: CompositionGeneration =
    comp.generation.state === 'streaming' || comp.generation.state === 'failed'
      ? { state: 'idle' }
      : comp.generation;
  return { ...comp, generation };
}

/** Drop transient generation states (generating/failed → idle), pending
 * clone samples (the staged File can't survive reload), and LocalAsset
 * audio uploads. Exported for per-slice persisters in wizardStore —
 * Phase 2c.4. */
export function persistVoice(voice: Voice): Voice {
  if (voice.source === 'upload') {
    return {
      source: 'upload',
      audio: persistAsset(voice.audio),
      script: voice.script,
    };
  }
  if (voice.source === 'clone') {
    const sample: VoiceCloneSample =
      voice.sample.state === 'pending' ? { state: 'empty' } : voice.sample;
    const generation: VoiceGeneration =
      voice.generation.state === 'generating' || voice.generation.state === 'failed'
        ? { state: 'idle' }
        : voice.generation;
    return { ...voice, sample, generation };
  }
  // tts
  const generation: VoiceGeneration =
    voice.generation.state === 'generating' || voice.generation.state === 'failed'
      ? { state: 'idle' }
      : voice.generation;
  return { ...voice, generation };
}

/** Public: strip everything that can't survive a page reload. */
export function toPersistable(state: WizardState): WizardState {
  return {
    ...state,
    host: persistHost(state.host),
    products: state.products.map(persistProduct),
    background: persistBackground(state.background),
    composition: persistComposition(state.composition),
    voice: persistVoice(state.voice),
  };
}

// ────────────────────────────────────────────────────────────────────
// Legacy migration — read a pre-schema persisted blob into the new shape.
// Runs once at hydrate time. Defensive: every field reads as `unknown`,
// every fallback maps to schema initial state.
// ────────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asObject(v: unknown): Raw {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {};
}

function migrateServerAsset(raw: unknown): ServerAsset | null {
  const r = asObject(raw);
  const path = asString(r.path);
  if (!path) return null;
  const url = typeof r.url === 'string' && !isTransientUrl(r.url) ? r.url : undefined;
  const name = typeof r.name === 'string' ? r.name : undefined;
  return { path, url, name };
}

function migrateHostBuilder(raw: unknown): HostBuilder {
  const r = asObject(raw);
  const out: HostBuilder = {};
  for (const k of ['성별', '연령대', '분위기', '옷차림'] as const) {
    if (typeof r[k] === 'string') out[k] = r[k] as string;
  }
  return out;
}

function migrateHostVariants(raw: unknown): HostVariant[] {
  return asArray(raw)
    .map((v) => {
      const o = asObject(v);
      const seed = asNumber(o.seed, NaN);
      const url = asString(o.url);
      const path = asString(o.path);
      // Legacy variants didn't carry imageId — derive from path
      // (filename stem without extension) to match the server-side
      // identifier scheme.
      const imageId = asString(o.imageId) || imageIdFromPath(path);
      // Drop placeholders / errors / transient URLs.
      if (o.placeholder || o.error || !url || !path || !imageId || isTransientUrl(url)) return null;
      return { seed, imageId, url, path } as HostVariant;
    })
    .filter((v): v is HostVariant => v !== null);
}

/** Filename stem (no extension) from a server path. Mirrors
 * `api/mapping.imageIdFromPath` — duplicated here so wizard/* has no
 * upstream import on api/*. */
function imageIdFromPath(path: string): string {
  const name = path.split('/').pop() || '';
  if (!name) return '';
  return name.endsWith('.png') ? name.slice(0, -4) : name;
}

function migrateHost(raw: unknown): Host {
  const r = asObject(raw);
  const mode = r.mode === 'image' ? 'image' : 'text';
  const input: HostInput =
    mode === 'text'
      ? {
          kind: 'text',
          prompt: asString(r.prompt),
          builder: migrateHostBuilder(r.builder),
          negativePrompt: asString(r.negativePrompt),
          extraPrompt: asString(r.extraPrompt),
        }
      : {
          kind: 'image',
          faceRef: migrateServerAsset(r.faceRef),
          outfitRef: migrateServerAsset(r.outfitRef),
          outfitText: asString(r.outfitText),
          extraPrompt: asString(r.extraPrompt),
          faceStrength: asNumber(r.faceStrength, 0.7),
          outfitStrength: asNumber(r.outfitStrength, 0.5),
        };

  const variants = migrateHostVariants(r.variants);
  const generation: HostGeneration = (() => {
    if (variants.length === 0) return { state: 'idle' };
    // Legacy "user picked one" signal — `generated: true` OR
    // `selectedSeed`/`selectedImageId`/`selectedPath` present.
    const selectedImageId =
      asString(r.selectedImageId) ||
      (asString(r.selectedPath) ? imageIdFromPath(asString(r.selectedPath)) : '');
    const selectedSeed = asNumber(r.selectedSeed, NaN);
    const selected =
      variants.find((v) => v.imageId === selectedImageId) ??
      variants.find((v) => v.seed === selectedSeed) ??
      null;
    return { state: 'ready', batchId: null, variants, selected, prevSelected: null };
  })();

  return {
    input,
    temperature: asNumber(r.temperature, 0.7),
    generation,
  };
}

function migrateProducts(raw: unknown): Products {
  return asArray(raw).map((v, i) => {
    const o = asObject(v);
    const id = asString(o.id) || `p${i}-${Date.now()}`;
    const name = typeof o.name === 'string' ? o.name : undefined;
    let source: ProductSource = { kind: 'empty' };
    const path = asString(o.path);
    if (path) {
      source = {
        kind: 'uploaded',
        asset: { path, url: typeof o.url === 'string' && !isTransientUrl(o.url) ? o.url : undefined, name },
      };
    } else if (typeof o.urlInput === 'string' && o.urlInput.trim()) {
      source = { kind: 'url', url: asString(o.url), urlInput: asString(o.urlInput) };
    }
    return { id, name, source };
  });
}

function migrateBackground(raw: unknown): Background {
  const r = asObject(raw);
  const source = r.source;
  if (source === 'prompt') {
    return { kind: 'prompt', prompt: asString(r.prompt) };
  }
  if (source === 'url') {
    return { kind: 'url', url: asString(r.url) };
  }
  if (source === 'upload') {
    const path = asString(r.uploadPath);
    if (path) {
      const url = typeof r.imageUrl === 'string' && !isTransientUrl(r.imageUrl) ? r.imageUrl : undefined;
      const name = typeof r.serverFilename === 'string' ? r.serverFilename : undefined;
      return { kind: 'upload', asset: { path, url, name } };
    }
    return { kind: 'upload', asset: null };
  }
  // preset (default)
  const preset = r.preset;
  const presetId = typeof preset === 'string' ? preset : typeof preset === 'object' && preset && 'id' in preset && typeof (preset as { id: unknown }).id === 'string' ? (preset as { id: string }).id : null;
  return { kind: 'preset', presetId };
}

function migrateCompositionVariants(raw: unknown): CompositionVariant[] {
  return migrateHostVariants(raw); // same shape
}

function migrateComposition(raw: unknown): Composition {
  const r = asObject(raw);
  const shot: CompositionShot = r.shot === 'close' || r.shot === 'far' ? r.shot : 'medium';
  const angle: CompositionAngle = r.angle === 'high' || r.angle === 'low' ? r.angle : 'eye';
  const settings = {
    direction: asString(r.direction),
    shot,
    angle,
    temperature: asNumber(r.temperature, 0.7),
    rembg: r.rembg !== false, // default true
  };
  const variants = migrateCompositionVariants(r.variants);
  const generation: CompositionGeneration =
    r.generated === true && variants.length > 0
      ? (() => {
          const selectedImageId = asString(r.selectedImageId);
          const selected = variants.find((v) => v.imageId === selectedImageId) ?? null;
          return { state: 'ready' as const, batchId: null, variants, selected, prevSelected: null };
        })()
      : variants.length > 0
        ? { state: 'ready' as const, batchId: null, variants, selected: null, prevSelected: null }
        : { state: 'idle' as const };
  return { settings, generation };
}

function migrateVoiceAdvanced(raw: unknown): VoiceAdvanced {
  const r = asObject(raw);
  return {
    speed: asNumber(r.speed, 1),
    stability: asNumber(r.stability, 0.5),
    style: asNumber(r.style, 0.3),
    similarity: asNumber(r.similarity, 0.75),
  };
}

function migrateScript(raw: unknown, fallbackString: string): Script {
  const paragraphs = asArray(raw).filter((p): p is string => typeof p === 'string');
  if (paragraphs.length > 0) return { paragraphs };
  if (fallbackString) return { paragraphs: [fallbackString] };
  return { paragraphs: [''] };
}

function migrateVoice(raw: unknown): Voice {
  const r = asObject(raw);
  const source = r.source === 'clone' || r.source === 'upload' ? r.source : 'tts';
  const advanced = migrateVoiceAdvanced(r);
  const script = migrateScript(r.paragraphs, asString(r.script));

  if (source === 'upload') {
    const u = asObject(r.uploadedAudio);
    const audio = u.path
      ? {
          path: asString(u.path),
          name: typeof u.name === 'string' ? u.name : undefined,
        }
      : null;
    return { source: 'upload', audio, script };
  }

  // For tts/clone, generation result lives in voice.generatedAudioPath/Url.
  const audioPath = asString(r.generatedAudioPath);
  const audioUrl = asString(r.generatedAudioUrl);
  const generation: VoiceGeneration =
    r.generated === true && audioPath
      ? { state: 'ready', audio: { path: audioPath, url: audioUrl || undefined } }
      : { state: 'idle' };

  if (source === 'clone') {
    const c = asObject(r.cloneSample);
    const sample: VoiceCloneSample =
      typeof c.voiceId === 'string'
        ? { state: 'cloned', voiceId: c.voiceId, name: typeof c.name === 'string' ? c.name : '내 목소리' }
        : { state: 'empty' };
    return { source: 'clone', sample, advanced, script, generation };
  }

  return {
    source: 'tts',
    voiceId: typeof r.voiceId === 'string' ? r.voiceId : null,
    voiceName: typeof r.voiceName === 'string' ? r.voiceName : null,
    advanced,
    script,
    generation,
  };
}

function migrateResolution(raw: unknown): ResolutionKey {
  const r = asObject(raw);
  const key = r.key;
  if (key === '448p' || key === '480p' || key === '720p' || key === '1080p') return key;
  return '448p';
}

function migrateImageQuality(raw: unknown): ImageQuality {
  return raw === '2K' || raw === '4K' ? raw : '1K';
}

/**
 * Read a pre-schema persisted state blob and produce a typed
 * WizardState. Defensive: anything malformed falls back to initial.
 */
export function migrateLegacy(raw: unknown): WizardState {
  if (!raw || typeof raw !== 'object') return INITIAL_WIZARD_STATE;
  const r = raw as Raw;
  return {
    host: r.host !== undefined ? migrateHost(r.host) : INITIAL_HOST,
    products: migrateProducts(r.products),
    background: r.background !== undefined ? migrateBackground(r.background) : INITIAL_BACKGROUND,
    composition: r.composition !== undefined ? migrateComposition(r.composition) : INITIAL_COMPOSITION,
    voice: r.voice !== undefined ? migrateVoice(r.voice) : INITIAL_VOICE,
    resolution: migrateResolution(r.resolution),
    imageQuality: migrateImageQuality(r.imageQuality),
    playlistId: typeof r.playlist_id === 'string' ? r.playlist_id : typeof r.playlistId === 'string' ? r.playlistId : null,
    wizardEpoch: asNumber(r.wizardEpoch, 0),
    lastSavedAt: typeof r.lastSavedAt === 'number' ? r.lastSavedAt : null,
  };
}

// Silence unused import warning until normalizers.ts is wired up.
void RESOLUTION_META;
