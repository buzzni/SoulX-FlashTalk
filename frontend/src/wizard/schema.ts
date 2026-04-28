/**
 * Wizard domain schema — canonical typed model for the 3-step video
 * wizard. The single source of truth for what the wizard *can* be in.
 *
 * Lane B (pipeline-stability plan) flipped this file from interface +
 * type aliases to **zod schemas** with `type X = z.infer<typeof XSchema>`.
 * Schemas are runtime-validatable now: the persist layer (Lane C) calls
 * `WizardStateSerializedSchema.safeParse` and form layers (Lanes D/F)
 * use these as the resolver. The shape is identical to the previous
 * `interface` exports so callers see no behavior change.
 *
 * Two state schemas exist:
 *   - WizardStateSchema           — runtime shape (LocalAsset's File
 *                                   handle present, blob: URLs valid).
 *   - WizardStateSerializedSchema — what hits localStorage. LocalAsset
 *                                   slots are dropped to null/empty so
 *                                   File handles never reach JSON.
 */

import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────
// Shared primitives
// ────────────────────────────────────────────────────────────────────

/**
 * A file uploaded to the server. The `path` is the canonical
 * persistable identifier (server filesystem location); `url` is the
 * HTTP URL we render in `<img>` tags. `name` is display-only (original
 * filename).
 */
export const ServerAssetSchema = z.object({
  path: z.string(),
  url: z.string().optional(),
  name: z.string().optional(),
});
export type ServerAsset = z.infer<typeof ServerAssetSchema>;

/**
 * A user-picked file that hasn't been uploaded to the server yet.
 * `previewUrl` is a `blob:` URL for instant rendering; the File
 * handle is needed later when the upload actually fires. NOT
 * persistable — normalizers drop these on hydrate.
 *
 * `z.instanceof(File)` only resolves in browser / jsdom environments.
 * Node-only tests must run under the `jsdom` test environment (vitest
 * config already does this).
 */
export const LocalAssetSchema = z.object({
  file: z.instanceof(File),
  previewUrl: z.string(),
  name: z.string(),
});
export type LocalAsset = z.infer<typeof LocalAssetSchema>;

// Persisted variant: LocalAsset can never live in localStorage (File
// has no JSON form). The serialized schemas below substitute null in
// every slot where LocalAsset was an option.

// ────────────────────────────────────────────────────────────────────
// Step 1 — Host (쇼호스트)
// ────────────────────────────────────────────────────────────────────

/** Categorical chips for text mode — gender / age / mood / outfit. */
export const HostBuilderSchema = z.object({
  성별: z.string().optional(),
  연령대: z.string().optional(),
  분위기: z.string().optional(),
  옷차림: z.string().optional(),
});
export type HostBuilder = z.infer<typeof HostBuilderSchema>;

/**
 * Host generation has two fundamentally different input modes — text
 * description vs reference photos. Tagged so consumers can't read
 * `prompt` from an `image`-mode state, and api-mappers know exactly
 * which backend endpoint flavour to invoke.
 */
export const HostInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    prompt: z.string(),
    builder: HostBuilderSchema,
    negativePrompt: z.string(),
    extraPrompt: z.string(),
  }),
  z.object({
    kind: z.literal('image'),
    faceRef: z.union([ServerAssetSchema, LocalAssetSchema, z.null()]),
    outfitRef: z.union([ServerAssetSchema, LocalAssetSchema, z.null()]),
    outfitText: z.string(),
    extraPrompt: z.string(),
    faceStrength: z.number(),
    outfitStrength: z.number(),
  }),
]);
export type HostInput = z.infer<typeof HostInputSchema>;

export const HostVariantSchema = z.object({
  seed: z.number(),
  imageId: z.string(),
  url: z.string(),
  path: z.string(),
});
export type HostVariant = z.infer<typeof HostVariantSchema>;

/**
 * Generation lifecycle (v9 — streaming-resume Phase B).
 *
 * The frontend treats generation as a thin handle: either nothing is
 * happening (`idle`) or a server-side job is in flight (`attached`).
 * Variants, batch_id, prev_selected, errors — all live on the server's
 * generation_jobs row, not in the wizard state. Hooks resolve
 * attached(jobId) → snapshot via jobCacheStore (step 14) and SSE.
 *
 * v8 used a 4-state discriminator (idle|streaming|ready|failed) that
 * duplicated the server's authoritative state. v9 drops it: persisted
 * v8 rows migrate to idle on first load. Ready results from v8 are NOT
 * lost — they live in studio_hosts (the candidates collection); v2.1's
 * history view will surface them.
 */
export const HostGenerationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('idle') }),
  z.object({ state: z.literal('attached'), jobId: z.string() }),
]);
export type HostGeneration = z.infer<typeof HostGenerationSchema>;

export const HostSchema = z.object({
  input: HostInputSchema,
  /** 0..1 creativity dial. Shared across modes. */
  temperature: z.number(),
  generation: HostGenerationSchema,
});
export type Host = z.infer<typeof HostSchema>;

// ────────────────────────────────────────────────────────────────────
// Step 2 — Products + Background + Composition
// ────────────────────────────────────────────────────────────────────

/**
 * A product the user wants featured. 4 source modes — empty (placeholder
 * row), local file (pre-upload), uploaded server asset, or external URL.
 */
export const ProductSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty') }),
  z.object({ kind: z.literal('localFile'), asset: LocalAssetSchema }),
  z.object({ kind: z.literal('uploaded'), asset: ServerAssetSchema }),
  z.object({ kind: z.literal('url'), url: z.string(), urlInput: z.string() }),
]);
export type ProductSource = z.infer<typeof ProductSourceSchema>;

export const ProductSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  source: ProductSourceSchema,
});
export type Product = z.infer<typeof ProductSchema>;

export const ProductsSchema = z.array(ProductSchema);
export type Products = z.infer<typeof ProductsSchema>;

/**
 * Background source — 4 sub-modes. Was the worst legacy offender —
 * single object had `source` enum + `preset` field + `url` field +
 * `prompt` field + `imageUrl` + `_gradient` + `_file` + `uploadPath`,
 * with no constraint that exactly one set was filled.
 *
 * preset: pick from curated list (AI generates fresh each time)
 * upload: user-supplied photo
 * url:    external image link
 * prompt: AI-generate from text description (nested generation)
 */
export const BackgroundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset'), presetId: z.string().nullable() }),
  z.object({
    kind: z.literal('upload'),
    asset: z.union([ServerAssetSchema, LocalAssetSchema, z.null()]),
  }),
  z.object({ kind: z.literal('url'), url: z.string() }),
  z.object({ kind: z.literal('prompt'), prompt: z.string() }),
]);
export type Background = z.infer<typeof BackgroundSchema>;

export const CompositionShotSchema = z.enum(['closeup', 'bust', 'medium', 'full']);
export type CompositionShot = z.infer<typeof CompositionShotSchema>;

export const CompositionAngleSchema = z.enum(['eye', 'high', 'low']);
export type CompositionAngle = z.infer<typeof CompositionAngleSchema>;

export const CompositionSettingsSchema = z.object({
  /** Free-text direction ("호스트 왼쪽에 1번 제품 들고 있게"). */
  direction: z.string(),
  shot: CompositionShotSchema,
  angle: CompositionAngleSchema,
  temperature: z.number(),
  /** true = strip product backgrounds before compositing (default).
   * false = keep original product photo background as-is. */
  rembg: z.boolean(),
});
export type CompositionSettings = z.infer<typeof CompositionSettingsSchema>;

export const CompositionVariantSchema = z.object({
  seed: z.number(),
  imageId: z.string(),
  url: z.string(),
  path: z.string(),
});
export type CompositionVariant = z.infer<typeof CompositionVariantSchema>;

/** v9 — same idle | attached(jobId) shape as HostGeneration. The
 * generation_jobs row carries kind='composite' so it dispatches to the
 * right backend handler; the frontend doesn't need to differentiate. */
export const CompositionGenerationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('idle') }),
  z.object({ state: z.literal('attached'), jobId: z.string() }),
]);
export type CompositionGeneration = z.infer<typeof CompositionGenerationSchema>;

export const CompositionSchema = z.object({
  settings: CompositionSettingsSchema,
  generation: CompositionGenerationSchema,
});
export type Composition = z.infer<typeof CompositionSchema>;

// ────────────────────────────────────────────────────────────────────
// Step 3 — Voice + Script + Resolution
// ────────────────────────────────────────────────────────────────────

export const VoiceAdvancedSchema = z.object({
  speed: z.number(),
  stability: z.number(),
  style: z.number(),
  similarity: z.number(),
});
export type VoiceAdvanced = z.infer<typeof VoiceAdvancedSchema>;

export const ScriptSchema = z.object({
  /** Multi-paragraph editor — each entry is one paragraph (joined
   * with `\n\n[breath]\n\n` for the backend). */
  paragraphs: z.array(z.string()),
});
export type Script = z.infer<typeof ScriptSchema>;

export const VoiceGenerationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('idle') }),
  z.object({ state: z.literal('generating') }),
  z.object({ state: z.literal('ready'), audio: ServerAssetSchema }),
  z.object({ state: z.literal('failed'), error: z.string() }),
]);
export type VoiceGeneration = z.infer<typeof VoiceGenerationSchema>;

export const VoiceCloneSampleSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('empty') }),
  z.object({ state: z.literal('pending'), asset: LocalAssetSchema }),
  z.object({ state: z.literal('cloned'), voiceId: z.string(), name: z.string() }),
]);
export type VoiceCloneSample = z.infer<typeof VoiceCloneSampleSchema>;

/**
 * Voice source — 3 modes with different pipelines:
 *   tts:    pick a stock voice + script → TTS generates audio
 *   clone:  upload a sample voice → backend clones, TTS uses cloned voice
 *   upload: bypass TTS entirely, use the user's pre-recorded audio
 */
export const VoiceSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('tts'),
    voiceId: z.string().nullable(),
    voiceName: z.string().nullable(),
    advanced: VoiceAdvancedSchema,
    script: ScriptSchema,
    generation: VoiceGenerationSchema,
  }),
  z.object({
    source: z.literal('clone'),
    sample: VoiceCloneSampleSchema,
    advanced: VoiceAdvancedSchema,
    script: ScriptSchema,
    generation: VoiceGenerationSchema,
  }),
  z.object({
    source: z.literal('upload'),
    audio: z.union([ServerAssetSchema, LocalAssetSchema, z.null()]),
    script: ScriptSchema, // for subtitle generation only — no TTS happens
  }),
]);
export type Voice = z.infer<typeof VoiceSchema>;

export const ResolutionKeySchema = z.enum(['448p', '480p', '720p', '1080p']);
export type ResolutionKey = z.infer<typeof ResolutionKeySchema>;

export interface ResolutionMeta {
  key: ResolutionKey;
  label: string;
  width: number;
  height: number;
}

/** Master meta table — derive everything else from this. Keeps store
 * lean (only the key is persisted) and consumers read computed
 * dimensions through `resolutionMeta(key)`. */
export const RESOLUTION_META: Record<ResolutionKey, ResolutionMeta> = {
  '448p': { key: '448p', label: '보통 화질', width: 448, height: 768 },
  '480p': { key: '480p', label: '기본 화질', width: 480, height: 832 },
  '720p': { key: '720p', label: '고화질(HD)', width: 720, height: 1280 },
  '1080p': { key: '1080p', label: '최고 화질(FHD)', width: 1080, height: 1920 },
};

export function resolutionMeta(key: ResolutionKey): ResolutionMeta {
  return RESOLUTION_META[key];
}

export const ImageQualitySchema = z.enum(['1K', '2K', '4K']);
export type ImageQuality = z.infer<typeof ImageQualitySchema>;

// ────────────────────────────────────────────────────────────────────
// Top-level wizard state
// ────────────────────────────────────────────────────────────────────

export const WizardStateSchema = z.object({
  host: HostSchema,
  products: ProductsSchema,
  background: BackgroundSchema,
  composition: CompositionSchema,
  voice: VoiceSchema,
  resolution: ResolutionKeySchema,
  imageQuality: ImageQualitySchema,
  /** Optional playlist to bundle the resulting video into. */
  playlistId: z.string().nullable(),
  /** Bumped on reset — step pages use this as a React key to remount. */
  wizardEpoch: z.number(),
  /** ms since epoch of the last successful slice write. Optional in
   * the schema so v8 blobs without it (the field landed in Lane D)
   * still parse. */
  lastSavedAt: z.number().nullable().default(null),
});
export type WizardState = z.infer<typeof WizardStateSchema>;

// ────────────────────────────────────────────────────────────────────
// Persisted variants — File-bearing slots replaced with safe shapes.
// ────────────────────────────────────────────────────────────────────

const HostInputSerializedSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    prompt: z.string(),
    builder: HostBuilderSchema,
    negativePrompt: z.string(),
    extraPrompt: z.string(),
  }),
  z.object({
    kind: z.literal('image'),
    faceRef: z.union([ServerAssetSchema, z.null()]),
    outfitRef: z.union([ServerAssetSchema, z.null()]),
    outfitText: z.string(),
    extraPrompt: z.string(),
    faceStrength: z.number(),
    outfitStrength: z.number(),
  }),
]);

const HostSerializedSchema = z.object({
  input: HostInputSerializedSchema,
  temperature: z.number(),
  generation: HostGenerationSchema,
});

const ProductSourceSerializedSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty') }),
  z.object({ kind: z.literal('uploaded'), asset: ServerAssetSchema }),
  z.object({ kind: z.literal('url'), url: z.string(), urlInput: z.string() }),
]);

const ProductSerializedSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  source: ProductSourceSerializedSchema,
});

const BackgroundSerializedSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset'), presetId: z.string().nullable() }),
  z.object({
    kind: z.literal('upload'),
    asset: z.union([ServerAssetSchema, z.null()]),
  }),
  z.object({ kind: z.literal('url'), url: z.string() }),
  z.object({ kind: z.literal('prompt'), prompt: z.string() }),
]);

const VoiceCloneSampleSerializedSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('empty') }),
  z.object({ state: z.literal('cloned'), voiceId: z.string(), name: z.string() }),
]);

const VoiceSerializedSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('tts'),
    voiceId: z.string().nullable(),
    voiceName: z.string().nullable(),
    advanced: VoiceAdvancedSchema,
    script: ScriptSchema,
    generation: VoiceGenerationSchema,
  }),
  z.object({
    source: z.literal('clone'),
    sample: VoiceCloneSampleSerializedSchema,
    advanced: VoiceAdvancedSchema,
    script: ScriptSchema,
    generation: VoiceGenerationSchema,
  }),
  z.object({
    source: z.literal('upload'),
    audio: z.union([ServerAssetSchema, z.null()]),
    script: ScriptSchema,
  }),
]);

export const WizardStateSerializedSchema = z.object({
  host: HostSerializedSchema,
  products: z.array(ProductSerializedSchema),
  background: BackgroundSerializedSchema,
  composition: CompositionSchema,
  voice: VoiceSerializedSchema,
  resolution: ResolutionKeySchema,
  imageQuality: ImageQualitySchema,
  playlistId: z.string().nullable(),
  wizardEpoch: z.number(),
  lastSavedAt: z.number().nullable().default(null),
});
export type WizardStateSerialized = z.infer<typeof WizardStateSerializedSchema>;

// ────────────────────────────────────────────────────────────────────
// Initial / default state
// ────────────────────────────────────────────────────────────────────

export const INITIAL_HOST: Host = {
  input: {
    kind: 'text',
    prompt: '',
    builder: {},
    negativePrompt: '',
    extraPrompt: '',
  },
  temperature: 0.7,
  generation: { state: 'idle' },
};

export const INITIAL_BACKGROUND: Background = {
  kind: 'preset',
  presetId: null,
};

export const INITIAL_COMPOSITION: Composition = {
  settings: {
    direction: '',
    shot: 'medium',
    angle: 'eye',
    temperature: 0.7,
    rembg: true,
  },
  generation: { state: 'idle' },
};

export const INITIAL_VOICE: Voice = {
  source: 'tts',
  voiceId: null,
  voiceName: null,
  advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 },
  script: { paragraphs: [''] },
  generation: { state: 'idle' },
};

export const INITIAL_WIZARD_STATE: WizardState = {
  host: INITIAL_HOST,
  products: [],
  background: INITIAL_BACKGROUND,
  composition: INITIAL_COMPOSITION,
  voice: INITIAL_VOICE,
  resolution: '448p',
  imageQuality: '1K',
  playlistId: null,
  wizardEpoch: 0,
  lastSavedAt: null,
};

// ────────────────────────────────────────────────────────────────────
// Type guards (small, frequently-needed predicates)
// ────────────────────────────────────────────────────────────────────

// v9: 'ready' is no longer a generation state — readiness now means the
// row has a server-side job attached AND that job's snapshot is ready
// AND the user has picked a candidate. None of those facts are visible
// on the schema yet (step 17 will add them via jobCacheStore + a
// host.selected field), so these guards return false during the
// transitional phase. Keeping the function names + signatures preserves
// the call sites; they'll start returning true once step 17 lands.
export function isHostReady(_host: Host): boolean {
  return false;
}

export function isCompositionReady(_comp: Composition): boolean {
  return false;
}

export function isBackgroundReady(bg: Background): boolean {
  switch (bg.kind) {
    case 'preset':
      return bg.presetId !== null;
    case 'upload':
      return bg.asset !== null;
    case 'url':
      return bg.url.trim().length > 0;
    case 'prompt':
      return bg.prompt.trim().length > 0;
  }
}

export function isProductReady(p: Product): boolean {
  switch (p.source.kind) {
    case 'empty':
      return false;
    case 'localFile':
    case 'uploaded':
    case 'url':
      return true;
  }
}

export function areProductsReady(products: Products): boolean {
  return products.length > 0 && products.some(isProductReady);
}

export function isScriptReady(script: Script): boolean {
  return script.paragraphs.some((p) => p.trim().length > 0);
}

export function isVoiceReady(voice: Voice): boolean {
  if (!isScriptReady(voice.script)) {
    // upload mode uses script as subtitle-only — still required
    if (voice.source !== 'upload') return false;
  }
  switch (voice.source) {
    case 'tts':
      return voice.voiceId !== null && voice.generation.state === 'ready';
    case 'clone':
      return voice.sample.state === 'cloned' && voice.generation.state === 'ready';
    case 'upload':
      return voice.audio !== null && voice.audio !== undefined &&
        ('path' in voice.audio); // only ServerAsset variant is "ready"
  }
}
