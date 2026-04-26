/**
 * wizardStore — the wizard's shared state (host / products / background /
 * composition / voice / resolution / imageQuality).
 *
 * Phase 2b per REFACTOR_PLAN.md. Replaces `useState(INITIAL_STATE)` +
 * `sanitizeForPersist` + `hydrateState` that used to live inline in
 * HostStudio.jsx. Zustand + `persist` middleware gives us:
 *  - Selector subscriptions (fix re-render storms when a keystroke in
 *    Step 3 updates script but Step 1 doesn't care).
 *  - Automatic localStorage round-trip — `partialize` is one-way: we
 *    decide what's safe to serialise at save time; hydration is plain
 *    object merge.
 *  - Single migration hook. If a user opens a new build while holding
 *    legacy `localStorage.showhost_state`, we ingest it once, write
 *    under the new key, delete the old — no bidirectional sanitize.
 *
 * Scope note (plan Decision #10): `step`, `rendering`, and
 * `attachToTaskId` do NOT live in this store. Phase 5 moves them into
 * the URL (`/step/:n`, `/render/:taskId`) so refresh preserves the
 * current screen. For Phase 2b they stay as local useState in
 * HostStudio — the store only owns the wizard's *content*.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { storageKey } from './storageKey';
import type {
  Background,
  Composition,
  Host,
  Product,
  ResolutionKey,
  Voice,
} from '../wizard/schema';
import {
  INITIAL_BACKGROUND,
  INITIAL_COMPOSITION,
  INITIAL_HOST,
  INITIAL_VOICE,
} from '../wizard/schema';
import {
  migrateLegacy as migrateLegacyToSchema,
  persistBackground,
  persistComposition,
  persistHost,
  persistVoice,
} from '../wizard/normalizers';

// ────────────────────────────────────────────────────────────────────
// Wizard state shape — every slice is schema-typed (Phase 2c.4
// completes the migration). Adding a new field on a slice requires
// updating the schema, normalizers (migrate + persist), and api-mappers.
// ────────────────────────────────────────────────────────────────────

export interface WizardState {
  /** Schema-typed (Phase 2b). input is a tagged union (text | image),
   * generation is a state machine (idle | streaming | ready | failed),
   * temperature shared across modes. */
  host: Host;
  /** Schema-typed (Phase 2c). Each product carries a tagged
   * `source: ProductSource` (empty | localFile | uploaded | url). */
  products: Product[];
  /** Schema-typed (Phase 2a). Tagged union — kind = preset | upload |
   * url | prompt. */
  background: Background;
  /** Schema-typed (Phase 2c). settings (direction, shot, angle,
   * temperature, rembg) + generation (state machine: idle |
   * streaming | ready | failed). */
  composition: Composition;
  /** Schema-typed (Phase 2c.4). Tagged union — source = tts | clone |
   * upload. tts/clone carry a `generation` state machine (idle |
   * generating | ready | failed); clone has a separate `sample` state
   * machine (empty | pending | cloned). upload bypasses TTS — `audio`
   * is the user-supplied recording. */
  voice: Voice;
  script: string;
  /** Schema-typed (Phase 2c). Just the key — full meta
   * (width/height/size/speed/label) is derived via `resolutionMeta`
   * from wizard/schema. Was a redundant 6-field object. */
  resolution: ResolutionKey;
  imageQuality: string;
  /** Bumped on every `reset()`. Step pages use this as a React key so
   * "처음부터 다시" forces a remount, clearing hook-local state (variants,
   * prevSelected, etc.) without requiring a page refresh. */
  wizardEpoch: number;
  [k: string]: unknown;
}

// ────────────────────────────────────────────────────────────────────
// Initial state — derived from the per-slice INITIAL_* constants in
// wizard/schema.ts so the store and the schema can never disagree on
// what "fresh" means.
// ────────────────────────────────────────────────────────────────────

export const INITIAL_WIZARD_STATE: WizardState = {
  host: INITIAL_HOST,
  products: [],
  background: INITIAL_BACKGROUND,
  composition: INITIAL_COMPOSITION,
  voice: INITIAL_VOICE,
  script: '',
  resolution: '448p',
  imageQuality: '1K',
  wizardEpoch: 0,
};

// The store holds WizardState + the action verbs. Keeping actions on
// the store (vs exporting standalone functions) lets `useWizardStore(
// (s) => s.setVoice)` subscribe just to the setter reference and skip
// rerenders when the rest of state changes.
export interface WizardActions {
  /** Schema-typed (Phase 2b). Replace-style — input is a tagged
   * union, generation is a state machine. Callers hand a full Host or
   * a deriver function. */
  setHost: (next: Host | ((prev: Host) => Host)) => void;
  setProducts: (updater: Product[] | ((p: Product[]) => Product[])) => void;
  /** Schema-typed (Phase 2a). Replace-style: callers pass the next
   * full Background or a function that derives it from the previous
   * value. No partial-patch — tagged unions don't compose with `Partial`. */
  setBackground: (next: Background | ((prev: Background) => Background)) => void;
  /** Schema-typed (Phase 2c). Replace-style — settings + generation
   * are tagged unions, no Partial composition. */
  setComposition: (next: Composition | ((prev: Composition) => Composition)) => void;
  /** Schema-typed (Phase 2c.4). Replace-style — Voice is a tagged
   * union, no Partial composition. Callers either pass a full Voice or
   * a deriver function. */
  setVoice: (next: Voice | ((prev: Voice) => Voice)) => void;
  setScript: (s: string) => void;
  /** Schema-typed (Phase 2c). Pass only the key — full meta is
   * derived via `resolutionMeta(key)`. */
  setResolution: (r: ResolutionKey) => void;
  setImageQuality: (q: string) => void;
  /** Replace-or-patch the entire wizard tree — used by HostStudio's
   * legacy `update(fn)` callback style during Phase 2b. Steps pass
   * functions that accept the full state and return either a full
   * state or a partial patch. Phase 4 tightens this to per-slice
   * setters only. */
  updateState: (updater: WizardState | ((state: WizardState) => WizardState | Partial<WizardState>)) => void;
  reset: () => void;
}

export type WizardStore = WizardState & WizardActions;

// ────────────────────────────────────────────────────────────────────
// Legacy migration — read the pre-Phase-2b key once, transform,
// write under the new key, delete the old. Idempotent: after the
// first load the old key is gone, so the migration no-ops on
// subsequent boots.
//
// Runs OUTSIDE the store (module-load side effect) so it fires before
// Zustand's persist middleware reads its key.
// ────────────────────────────────────────────────────────────────────

const LEGACY_STATE_KEY = 'showhost_state';
const LEGACY_STEP_KEY = 'showhost_step';

function migrateLegacyStateOnce(): void {
  try {
    const legacyRaw = localStorage.getItem(LEGACY_STATE_KEY);
    if (!legacyRaw) return;
    const legacy = JSON.parse(legacyRaw) as Record<string, unknown>;

    // Shape-translate: the legacy shape used nested objects that mostly
    // overlap with WizardState. Fields that renamed or dropped entirely
    // in the refactor are cherry-picked here.
    const merged: WizardState = {
      ...INITIAL_WIZARD_STATE,
      // Phase 2b: host is schema-typed (input + generation tagged
      // unions). Run the schema migrator on the legacy raw value.
      host: migrateLegacyToSchema({ host: legacy.host }).host,
      // Phase 2c: products → schema with tagged ProductSource.
      products: migrateLegacyToSchema({ products: legacy.products }).products,
      // Phase 2a: background is now schema-typed (tagged union). Run
       // the schema migrator on the legacy raw value rather than spreading
       // optional fields into a Background that wouldn't satisfy any kind.
      background: migrateLegacyToSchema({ background: legacy.background }).background,
      // Phase 2c: composition is schema-typed (settings + generation
      // state machine).
      composition: migrateLegacyToSchema({ composition: legacy.composition }).composition,
      // Phase 2c.4: voice is schema-typed (tagged union over source +
      // sample/generation state machines).
      voice: migrateLegacyToSchema({ voice: legacy.voice }).voice,
      script: typeof legacy.script === 'string' ? legacy.script : '',
      // Phase 2c: resolution → schema key string (lookup via
      // resolutionMeta).
      resolution: migrateLegacyToSchema({ resolution: legacy.resolution }).resolution,
      imageQuality:
        (typeof legacy.imageQuality === 'string' ? legacy.imageQuality : INITIAL_WIZARD_STATE.imageQuality),
    };

    // Write to the new key using Zustand's persist envelope shape so
    // the middleware picks it up on first read. `merged` is already
    // schema-shaped (every slice run through migrateLegacyToSchema),
    // so we tag it with the current persist version (7) — Zustand's
    // own migrate() then sees a matching version and skips re-migration.
    const envelope = { state: partializeForPersist(merged), version: 7 };
    localStorage.setItem(storageKey('wizard'), JSON.stringify(envelope));

    // Preserve the step the user was on. Without this, a user upgrading
    // mid-wizard (at Step 2 or 3) keeps all their data but lands back
    // on Step 1 after refresh — data survives, place in the flow
    // doesn't. Carry the legacy `showhost_step` over to the new
    // `showhost.step.v1` key before deleting the old one.
    const legacyStep = localStorage.getItem(LEGACY_STEP_KEY);
    if (legacyStep != null) {
      const n = Number(legacyStep);
      if (Number.isFinite(n) && n >= 1 && n <= 3) {
        localStorage.setItem(storageKey('step'), String(Math.floor(n)));
      }
    }

    localStorage.removeItem(LEGACY_STATE_KEY);
    localStorage.removeItem(LEGACY_STEP_KEY);
  } catch {
    // Broken legacy payload — drop it silently. The user lands on a
    // fresh wizard instead of a crash loop.
    try {
      localStorage.removeItem(LEGACY_STATE_KEY);
      localStorage.removeItem(LEGACY_STEP_KEY);
    } catch {
      /* storage unavailable — nothing we can do */
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// `partialize` — what actually goes into localStorage.
//
// Drops anything that can't survive a page reload:
//   - File objects (persist would serialise them to `{}`, which then
//     looks like "a File is still here" on hydrate but has no real
//     handle — caused "upload produces [object Object]" bugs).
//   - blob:/data: URLs (the blob's source tab may be closed; data:
//     URLs for multi-MB uploads eat localStorage quota).
//   - Placeholder / error variants (only meaningful mid-stream; if a
//     reload happens the stream is gone).
// ────────────────────────────────────────────────────────────────────

function partializeForPersist(s: WizardState): WizardState {
  // Phase 2b: host uses schema-typed persist — drops mid-stream
  // generation states (streaming/failed → idle), strips LocalAsset
  // refs from image-mode input.
  const cleanHost: Host = persistHost(s.host);
  // Phase 2c: composition uses same pattern.
  const cleanComposition: Composition = persistComposition(s.composition);
  // Phase 2a: background uses schema-typed persist — drops LocalAsset
  // (File handle + blob URL) but keeps ServerAsset.
  const cleanBackground: Background = persistBackground(s.background);
  // Phase 2c: products are schema-typed. localFile rows (transient
  // File handle + blob/data: URL preview) collapse to empty so the
  // user sees a fresh slot to re-upload after reload.
  const cleanProducts: Product[] = s.products.map((p) => {
    if (p.source.kind === 'localFile') {
      return { ...p, source: { kind: 'empty' as const } };
    }
    return p;
  });
  // Phase 2c.4: voice is schema-typed. Drops transient generation
  // states, pending clone samples (the staged File can't reload), and
  // LocalAsset audio uploads (only ServerAsset survives).
  const cleanVoice: Voice = persistVoice(s.voice);

  return {
    ...s,
    host: cleanHost,
    composition: cleanComposition,
    background: cleanBackground,
    products: cleanProducts,
    voice: cleanVoice,
  };
}

// ────────────────────────────────────────────────────────────────────
// Fire the migration exactly once per page load, BEFORE Zustand's
// persist middleware reads storage.
// ────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  migrateLegacyStateOnce();
}

// ────────────────────────────────────────────────────────────────────
// Store definition
// ────────────────────────────────────────────────────────────────────

export const useWizardStore = create<WizardStore>()(
  persist(
    (set) => ({
      ...INITIAL_WIZARD_STATE,

      setHost: (next) =>
        set((s) => ({
          host: typeof next === 'function' ? next(s.host) : next,
        })),
      setProducts: (updater) =>
        set((s) => ({
          products:
            typeof updater === 'function'
              ? (updater as (p: WizardState['products']) => WizardState['products'])(s.products)
              : updater,
        })),
      setBackground: (next) =>
        set((s) => ({
          background: typeof next === 'function' ? next(s.background) : next,
        })),
      setComposition: (next) =>
        set((s) => ({
          composition: typeof next === 'function' ? next(s.composition) : next,
        })),
      setVoice: (next) =>
        set((s) => ({
          voice: typeof next === 'function' ? next(s.voice) : next,
        })),
      setScript: (script) => set({ script }),
      setResolution: (resolution) => set({ resolution }),
      setImageQuality: (imageQuality) => set({ imageQuality }),

      updateState: (updater) =>
        set((s) => {
          const next = typeof updater === 'function' ? updater(s) : updater;
          return { ...s, ...next };
        }),

      reset: () =>
        set((s) => ({
          ...INITIAL_WIZARD_STATE,
          wizardEpoch: ((s.wizardEpoch as number | undefined) ?? 0) + 1,
        })),
    }),
    {
      name: storageKey('wizard'),
      storage: createJSONStorage(() => localStorage),
      // Strip transient fields at save time. One-way — no inverse
      // hydrator needed, just a plain merge against INITIAL state.
      partialize: (state) => partializeForPersist(state),
      // Schema migration history:
      //   v2: background → tagged union {kind: preset|upload|url|prompt}
      //   v3: host → schema {input (tagged), temperature, generation
      //       (state machine)}
      //   v4: resolution → key string only (was {key, label, width,
      //       height, size, speed, default} object — meta derived via
      //       resolutionMeta(key))
      //   v5: products → tagged-union source (empty | localFile |
      //       uploaded | url). Was a flat object with optional
      //       url/_file/path/source/urlInput fields.
      //   v6: composition → schema {settings, generation} state
      //       machine. Was flat {direction, shot, angle, temperature,
      //       generated, selectedSeed/Path/Url/ImageId, variants}.
      //   v7: voice → tagged union over source (tts | clone | upload),
      //       with `generation` state machine and (clone-only) `sample`
      //       state machine. Was a flat object with `generated`,
      //       `generatedAudioPath/Url`, `cloneSample`, `uploadedAudio`,
      //       `paragraphs`, `script`, plus advanced sliders.
      version: 7,
      migrate: (persisted, fromVersion) => {
        if (!persisted || typeof persisted !== 'object') return persisted as WizardState;
        const p = persisted as Record<string, unknown>;
        if (fromVersion < 2) {
          p.background = migrateLegacyToSchema({ background: p.background }).background;
        }
        if (fromVersion < 3) {
          p.host = migrateLegacyToSchema({ host: p.host }).host;
        }
        if (fromVersion < 4) {
          p.resolution = migrateLegacyToSchema({ resolution: p.resolution }).resolution;
        }
        if (fromVersion < 5) {
          p.products = migrateLegacyToSchema({ products: p.products }).products;
        }
        if (fromVersion < 6) {
          p.composition = migrateLegacyToSchema({ composition: p.composition }).composition;
        }
        if (fromVersion < 7) {
          p.voice = migrateLegacyToSchema({ voice: p.voice }).voice;
        }
        return p as WizardState;
      },
    },
  ),
);

// ────────────────────────────────────────────────────────────────────
// Test / debug helpers — not part of the public surface.
// ────────────────────────────────────────────────────────────────────

export const __wizardStoreInternals = {
  /** Re-run the legacy migration explicitly (tests set up a legacy
   * payload, call this, then assert the new-key write + old-key
   * delete). Module-level migration already ran once at import; this
   * is idempotent and re-runs with whatever is in storage now. */
  migrate: migrateLegacyStateOnce,
  /** Restore INITIAL_WIZARD_STATE without writing to storage — used
   * between tests to prevent state bleed. */
  reset: () => useWizardStore.setState(INITIAL_WIZARD_STATE, false),
  /** Legacy keys for tests that need to seed or assert cleanup. */
  LEGACY_STATE_KEY,
  LEGACY_STEP_KEY,
  partializeForPersist,
};
