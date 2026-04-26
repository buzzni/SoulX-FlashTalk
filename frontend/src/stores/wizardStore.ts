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
import type { Background, Host, ResolutionKey } from '../wizard/schema';
import { INITIAL_BACKGROUND, INITIAL_HOST } from '../wizard/schema';
import {
  migrateLegacy as migrateLegacyToSchema,
  persistBackground,
  persistHost,
} from '../wizard/normalizers';

// ────────────────────────────────────────────────────────────────────
// Wizard state shape
//
// Intentionally typed loosely here (`Record<string, unknown>` on each
// slice) because existing Step1/Step2/Step3 components read and write
// ~40 fields that haven't been formally catalogued yet. Phase 4
// component decomposition will tighten these types as each Step
// gets split. Until then, matching the legacy shape verbatim keeps
// the components working with zero prop changes.
//
// The typed surface in src/types/app.d.ts (WizardHost, WizardProduct,
// etc.) documents the canonical subset; anything beyond that is
// allowed to pass through the store unchanged.
// ────────────────────────────────────────────────────────────────────

export type WizardSlice = Record<string, unknown>;

export interface WizardState {
  /** Schema-typed (Phase 2b). input is a tagged union (text | image),
   * generation is a state machine (idle | streaming | ready | failed),
   * temperature shared across modes. */
  host: Host;
  products: WizardSlice[];
  /** Schema-typed (Phase 2a). Tagged union — kind = preset | upload |
   * url | prompt. */
  background: Background;
  composition: WizardSlice;
  voice: WizardSlice;
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
// Initial state — byte-for-byte compatible with the legacy
// INITIAL_STATE that used to live in HostStudio.jsx so no Step
// component sees a shape change in Phase 2b.
// ────────────────────────────────────────────────────────────────────

export const INITIAL_WIZARD_STATE: WizardState = {
  host: INITIAL_HOST,
  products: [],
  background: INITIAL_BACKGROUND,
  composition: {
    direction: '',
    shot: 'medium',
    angle: 'eye',
    generated: false,
    selectedSeed: null,
    temperature: 0.7,
    variants: [],
  },
  voice: {
    source: 'tts',
    voiceId: null,
    voiceName: null,
    paragraphs: [''],
    script: '',
    stability: 0.5,
    style: 0.3,
    similarity: 0.75,
    speed: 1,
    generated: false,
    uploadedAudio: null,
    cloneSample: null,
  },
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
  setProducts: (updater: WizardSlice[] | ((p: WizardSlice[]) => WizardSlice[])) => void;
  /** Schema-typed (Phase 2a). Replace-style: callers pass the next
   * full Background or a function that derives it from the previous
   * value. No partial-patch — tagged unions don't compose with `Partial`. */
  setBackground: (next: Background | ((prev: Background) => Background)) => void;
  setComposition: (patch: WizardSlice) => void;
  setVoice: (patch: WizardSlice) => void;
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
      products: Array.isArray(legacy.products)
        ? (legacy.products as WizardState['products'])
        : INITIAL_WIZARD_STATE.products,
      // Phase 2a: background is now schema-typed (tagged union). Run
       // the schema migrator on the legacy raw value rather than spreading
       // optional fields into a Background that wouldn't satisfy any kind.
      background: migrateLegacyToSchema({ background: legacy.background }).background,
      composition: {
        ...INITIAL_WIZARD_STATE.composition,
        ...(legacy.composition as Record<string, unknown> | undefined),
      },
      voice: {
        ...INITIAL_WIZARD_STATE.voice,
        ...(legacy.voice as Record<string, unknown> | undefined),
      },
      script: typeof legacy.script === 'string' ? legacy.script : '',
      // Phase 2c: resolution → schema key string (lookup via
      // resolutionMeta).
      resolution: migrateLegacyToSchema({ resolution: legacy.resolution }).resolution,
      imageQuality:
        (typeof legacy.imageQuality === 'string' ? legacy.imageQuality : INITIAL_WIZARD_STATE.imageQuality),
    };

    // Write to the new key using Zustand's persist envelope shape so
    // the middleware picks it up on first read. `merged` is already
    // schema-shaped (host + background through migrateLegacyToSchema),
    // so we tag it with the current persist version (3) — Zustand's
    // own migrate() then sees a matching version and skips re-migration.
    const envelope = { state: partializeForPersist(merged), version: 4 };
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

function isTransientUrl(u: unknown): boolean {
  return typeof u === 'string' && (u.startsWith('blob:') || u.startsWith('data:'));
}

// Variants carry their own URL under either `imageUrl` (host) or `url`
// (composition). We only keep entries whose display URL is a real
// server URL — placeholder/error rows and any transient blob/data
// URLs get dropped so localStorage never holds a URL that won't
// resolve after a refresh.
function cleanVariantRow(row: unknown): unknown {
  if (!row || typeof row !== 'object') return null;
  const r = row as { url?: unknown; imageUrl?: unknown; placeholder?: unknown; error?: unknown };
  if (r.placeholder || r.error) return null;
  const urlish = (typeof r.url === 'string' && r.url) || (typeof r.imageUrl === 'string' && r.imageUrl);
  if (!urlish || isTransientUrl(urlish)) return null;
  return row;
}
function cleanVariantsList(arr: unknown): unknown[] {
  if (!Array.isArray(arr)) return [];
  return arr.map(cleanVariantRow).filter((v) => v !== null);
}

function dropTransient(u: unknown): unknown {
  return isTransientUrl(u) ? null : u;
}

function partializeForPersist(s: WizardState): WizardState {
  const composition = s.composition ?? {};
  const voice = s.voice ?? {};

  // Phase 2b: host uses schema-typed persist — drops mid-stream
  // generation states (streaming/failed → idle), strips LocalAsset
  // refs from image-mode input.
  const cleanHost: Host = persistHost(s.host);
  const cleanComposition: WizardSlice = {
    ...composition,
    variants: cleanVariantsList(composition.variants),
    selectedUrl: dropTransient(composition.selectedUrl),
  };
  // Phase 2a: background uses schema-typed persist — drops LocalAsset
  // (File handle + blob URL) but keeps ServerAsset.
  const cleanBackground: Background = persistBackground(s.background);
  const cleanProducts: WizardSlice[] = (Array.isArray(s.products) ? s.products : []).map((p) => {
    // Strip `_file` (a File handle) and transient blob URLs; keep the
    // server `path` so uploads survive reload.
    const { _file: _drop, ...rest } = p as Record<string, unknown> & { _file?: unknown };
    void _drop;
    return {
      ...rest,
      url: dropTransient(rest.url),
    };
  });
  const cleanVoice: WizardSlice = {
    ...voice,
    // Uploaded audio is safe if we have a server path — drop the
    // transient File handle embedded in it.
    uploadedAudio:
      (voice.uploadedAudio as { path?: string } | null)?.path
        ? {
            path: (voice.uploadedAudio as { path?: string }).path,
            name: (voice.uploadedAudio as { name?: string }).name,
          }
        : null,
    // Clone sample only survives if it carries a voiceId (the server
    // side of the clone call returned one) — otherwise it was just a
    // staged File that's gone after reload.
    cloneSample:
      (voice.cloneSample as { voiceId?: string } | null)?.voiceId
        ? {
            voiceId: (voice.cloneSample as { voiceId?: string }).voiceId,
            name: (voice.cloneSample as { name?: string }).name,
          }
        : null,
  };

  return {
    ...s,
    host: cleanHost,
    composition: cleanComposition,
    background: cleanBackground,
    products: cleanProducts,
    voice: cleanVoice,
  };
}

function cleanRefHandle(ref: unknown): unknown {
  if (!ref || typeof ref !== 'object') return null;
  const r = ref as { url?: unknown; name?: string; size?: number; type?: string };
  if (typeof r.url !== 'string' || isTransientUrl(r.url)) return null;
  return { name: r.name, size: r.size, type: r.type, url: r.url };
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
      setComposition: (patch) =>
        set((s) => ({ composition: { ...s.composition, ...patch } })),
      setVoice: (patch) =>
        set((s) => ({ voice: { ...s.voice, ...patch } })),
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
      version: 4,
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
