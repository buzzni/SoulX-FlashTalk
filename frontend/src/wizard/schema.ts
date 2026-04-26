/**
 * Wizard domain schema — canonical typed model for the 3-step video
 * wizard. The single source of truth for what the wizard *can* be in.
 *
 * Why this file exists:
 *   The legacy store declared `WizardSlice = Record<string, unknown>`
 *   and every consumer re-asserted its own shape. Optional fields
 *   (`_gradient`, `_file`, `imageUrl`, `selectedPath`, `path`,
 *   `uploadPath`, ...) floated through UI / persistence / API mappers
 *   with nobody owning their lifecycle, so legacy fields lived on for
 *   months after their consumers were deleted, and "impossible
 *   combinations" (background.preset + background.url + background.prompt
 *   all set at once) were free to occur.
 *
 *   Tagged unions push those shapes into the type system. If a state
 *   isn't expressible as a valid schema member, the compiler rejects
 *   it. Backend payloads are produced *only* by mappers that take
 *   schema types, so wire format can't drift either.
 *
 * Sub-files (planned):
 *   normalizers.ts — File handle / blob URL stripping for persistence,
 *     legacy → schema migration on hydrate.
 *   api-mappers.ts — schema state → backend request payloads (the only
 *     place that constructs FormData for /api/host/generate etc).
 *   validation.ts  — replaces routes/wizardValidation.ts; checks
 *     readiness per step from schema types instead of `any`.
 *
 * Migration strategy: this file lives alongside the legacy store. Each
 * slice migrates one at a time (Phase 2a/2b/2c) — see
 * docs/frontend-refactor-plan.md.
 */

// ────────────────────────────────────────────────────────────────────
// Shared primitives
// ────────────────────────────────────────────────────────────────────

/**
 * A file uploaded to the server. The `path` is the canonical
 * persistable identifier (server filesystem location); `url` is the
 * HTTP URL we render in `<img>` tags. `name` is display-only (original
 * filename).
 */
export interface ServerAsset {
  path: string;
  url?: string;
  name?: string;
}

/**
 * A user-picked file that hasn't been uploaded to the server yet.
 * `previewUrl` is a `blob:` URL for instant rendering; the File
 * handle is needed later when the upload actually fires. NOT
 * persistable — normalizers drop these on hydrate.
 */
export interface LocalAsset {
  file: File;
  previewUrl: string;
  name: string;
}

// ────────────────────────────────────────────────────────────────────
// Step 1 — Host (쇼호스트)
// ────────────────────────────────────────────────────────────────────

/**
 * Host generation has two fundamentally different input modes — text
 * description vs reference photos. Tagged so consumers can't read
 * `prompt` from an `image`-mode state, and api-mappers know exactly
 * which backend endpoint flavour to invoke.
 */
export type HostInput =
  | {
      kind: 'text';
      prompt: string;
      builder: HostBuilder;
      negativePrompt: string;
      extraPrompt: string;
    }
  | {
      kind: 'image';
      faceRef: ServerAsset | LocalAsset | null;
      outfitRef: ServerAsset | LocalAsset | null;
      outfitText: string;
      extraPrompt: string;
      faceStrength: number;
      outfitStrength: number;
    };

/** Categorical chips for text mode — gender / age / mood / outfit. */
export type HostBuilder = Partial<Record<'성별' | '연령대' | '분위기' | '옷차림', string>>;

export interface HostVariant {
  seed: number;
  imageId: string;
  url: string;
  path: string;
}

/**
 * Generation lifecycle. Discriminator `state` rules out invalid combos
 * (e.g. you can't have a `selected` variant in `idle`, can't be
 * `streaming` and have a `failed.error` simultaneously).
 */
export type HostGeneration =
  | { state: 'idle' }
  | { state: 'streaming'; batchId: string | null; variants: HostVariant[] }
  | {
      state: 'ready';
      batchId: string | null;
      variants: HostVariant[];
      selected: HostVariant | null; // null = generated but not picked yet
      prevSelected: HostVariant | null;
    }
  | { state: 'failed'; error: string };

export interface Host {
  input: HostInput;
  /** 0..1 creativity dial. Shared across modes. */
  temperature: number;
  generation: HostGeneration;
}

// ────────────────────────────────────────────────────────────────────
// Step 2 — Products + Background + Composition
// ────────────────────────────────────────────────────────────────────

/**
 * A product the user wants featured. 4 source modes — empty (placeholder
 * row), local file (pre-upload), uploaded server asset, or external URL.
 */
export type ProductSource =
  | { kind: 'empty' }
  | { kind: 'localFile'; asset: LocalAsset }
  | { kind: 'uploaded'; asset: ServerAsset }
  | { kind: 'url'; url: string; urlInput: string };

export interface Product {
  id: string;
  name?: string;
  source: ProductSource;
}

export type Products = Product[];

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
export type Background =
  | { kind: 'preset'; presetId: string | null }
  | {
      kind: 'upload';
      asset: ServerAsset | LocalAsset | null; // null = drop zone empty
    }
  | { kind: 'url'; url: string }
  | { kind: 'prompt'; prompt: string };

export type CompositionShot = 'close' | 'medium' | 'far';
export type CompositionAngle = 'eye' | 'high' | 'low';

export interface CompositionSettings {
  /** Free-text direction ("호스트 왼쪽에 1번 제품 들고 있게"). */
  direction: string;
  shot: CompositionShot;
  angle: CompositionAngle;
  temperature: number;
  /** true = strip product backgrounds before compositing (default).
   * false = keep original product photo background as-is. */
  rembg: boolean;
}

export interface CompositionVariant {
  seed: number;
  imageId: string;
  url: string;
  path: string;
}

export type CompositionGeneration =
  | { state: 'idle' }
  | { state: 'streaming'; batchId: string | null; variants: CompositionVariant[] }
  | {
      state: 'ready';
      batchId: string | null;
      variants: CompositionVariant[];
      selected: CompositionVariant | null;
      prevSelected: CompositionVariant | null;
    }
  | { state: 'failed'; error: string };

export interface Composition {
  settings: CompositionSettings;
  generation: CompositionGeneration;
}

// ────────────────────────────────────────────────────────────────────
// Step 3 — Voice + Script + Resolution
// ────────────────────────────────────────────────────────────────────

export interface VoiceAdvanced {
  speed: number;
  stability: number;
  style: number;
  similarity: number;
}

export interface Script {
  /** Multi-paragraph editor — each entry is one paragraph (joined
   * with `\n\n[breath]\n\n` for the backend). */
  paragraphs: string[];
}

export type VoiceGeneration =
  | { state: 'idle' }
  | { state: 'generating' }
  | { state: 'ready'; audio: ServerAsset }
  | { state: 'failed'; error: string };

/**
 * Voice source — 3 modes with different pipelines:
 *   tts:    pick a stock voice + script → TTS generates audio
 *   clone:  upload a sample voice → backend clones, TTS uses cloned voice
 *   upload: bypass TTS entirely, use the user's pre-recorded audio
 */
export type Voice =
  | {
      source: 'tts';
      voiceId: string | null;
      voiceName: string | null;
      advanced: VoiceAdvanced;
      script: Script;
      generation: VoiceGeneration;
    }
  | {
      source: 'clone';
      sample: VoiceCloneSample;
      advanced: VoiceAdvanced;
      script: Script;
      generation: VoiceGeneration;
    }
  | {
      source: 'upload';
      audio: ServerAsset | LocalAsset | null;
      script: Script; // for subtitle generation only — no TTS happens
    };

export type VoiceCloneSample =
  | { state: 'empty' }
  | { state: 'pending'; asset: LocalAsset }
  | { state: 'cloned'; voiceId: string; name: string };

export type ResolutionKey = '448p' | '480p' | '720p' | '1080p';

export interface ResolutionMeta {
  key: ResolutionKey;
  label: string;
  width: number;
  height: number;
  /** Estimated render output size, e.g. "약 28MB". */
  size: string;
  /** Subjective speed label, e.g. "빠름", "보통", "느림". */
  speed: string;
}

/** Master meta table — derive everything else from this. Keeps store
 * lean (only the key is persisted) and consumers read computed
 * dimensions through `resolutionMeta(key)`. */
export const RESOLUTION_META: Record<ResolutionKey, ResolutionMeta> = {
  '448p': { key: '448p', label: '보통 화질', width: 448, height: 768, size: '약 8MB', speed: '빠름' },
  '480p': { key: '480p', label: '기본 화질', width: 480, height: 832, size: '약 14MB', speed: '빠름' },
  '720p': { key: '720p', label: '고화질(HD)', width: 720, height: 1280, size: '약 28MB', speed: '보통' },
  '1080p': { key: '1080p', label: '최고 화질(FHD)', width: 1080, height: 1920, size: '약 62MB', speed: '느림' },
};

export function resolutionMeta(key: ResolutionKey): ResolutionMeta {
  return RESOLUTION_META[key];
}

export type ImageQuality = '1K' | '2K' | '4K';

// ────────────────────────────────────────────────────────────────────
// Top-level wizard state
// ────────────────────────────────────────────────────────────────────

export interface WizardState {
  host: Host;
  products: Products;
  background: Background;
  composition: Composition;
  voice: Voice;
  resolution: ResolutionKey;
  imageQuality: ImageQuality;
  /** Optional playlist to bundle the resulting video into. */
  playlistId: string | null;
  /** Bumped on reset — step pages use this as a React key to remount. */
  wizardEpoch: number;
}

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
};

// ────────────────────────────────────────────────────────────────────
// Type guards (small, frequently-needed predicates)
// ────────────────────────────────────────────────────────────────────

export function isHostReady(host: Host): host is Host & { generation: { state: 'ready'; selected: HostVariant } } {
  return host.generation.state === 'ready' && host.generation.selected !== null;
}

export function isCompositionReady(comp: Composition): comp is Composition & { generation: { state: 'ready'; selected: CompositionVariant } } {
  return comp.generation.state === 'ready' && comp.generation.selected !== null;
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
