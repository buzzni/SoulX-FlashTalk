/**
 * wizardStore — the wizard's shared state (host / products / background /
 * composition / voice / resolution / imageQuality).
 *
 * Zustand + `persist` middleware gives us:
 *  - Selector subscriptions (fix re-render storms when a keystroke in
 *    Step 3 updates script but Step 1 doesn't care).
 *  - Automatic localStorage round-trip — `partialize` is one-way: we
 *    decide what's safe to serialise at save time; hydration is plain
 *    object merge.
 *  - Single migration hook. If a user opens a new build while holding
 *    legacy `localStorage.showhost_state`, we ingest it once, write
 *    under the new key, delete the old — no bidirectional sanitize.
 *
 * Scope: `step`, `rendering`, and `attachToTaskId` live in the URL
 * (`/step/:n`, `/render/:taskId`), not this store — refresh preserves
 * the current screen that way. The store only owns the wizard's content.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { storageKey, subscribeScope, localStorageKeys, sessionStorageKeys } from './storageKey';
import type {
  Background,
  Composition,
  Host,
  ImageQuality,
  Product,
  ResolutionKey,
  Voice,
  VoiceCloneSample,
  WizardState,
} from '../wizard/schema';
import {
  INITIAL_BACKGROUND,
  INITIAL_COMPOSITION,
  INITIAL_HOST,
  INITIAL_VOICE,
  WizardStateSerializedSchema,
} from '../wizard/schema';
import {
  migrateImageQuality,
  migrateLegacy as migrateLegacyToSchema,
  persistBackground,
  persistComposition,
  persistHost,
  persistVoice,
} from '../wizard/normalizers';

// Wizard state shape lives in wizard/schema.ts. Re-exported here so
// adding a field flows through one type, not two.
export type { WizardState };

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
  resolution: '448p',
  imageQuality: '1K',
  playlistId: null,
  wizardEpoch: 0,
  lastSavedAt: null,
};

// The store holds WizardState + the action verbs. Keeping actions on
// the store (vs exporting standalone functions) lets `useWizardStore(
// (s) => s.setVoice)` subscribe just to the setter reference and skip
// rerenders when the rest of state changes.
export interface WizardActions {
  /** Replace-style. Tagged unions don't compose with `Partial`, so
   * callers either pass a full slice or a deriver function. */
  setHost: (next: Host | ((prev: Host) => Host)) => void;
  setProducts: (updater: Product[] | ((p: Product[]) => Product[])) => void;
  setBackground: (next: Background | ((prev: Background) => Background)) => void;
  setComposition: (next: Composition | ((prev: Composition) => Composition)) => void;
  setVoice: (next: Voice | ((prev: Voice) => Voice)) => void;
  setResolution: (r: ResolutionKey) => void;
  setImageQuality: (q: ImageQuality) => void;
  setPlaylistId: (id: string | null) => void;
  /** Stamp lastSavedAt = Date.now() — RHF/debounced sync hooks call
   * this directly when they want to surface the "방금 전 저장됨" badge
   * without a slice write. Most callers don't need it; setHost/etc.
   * already stamp internally. */
  touchLastSavedAt: () => void;
  /** Whole-tree replace-or-patch. Used by step pages still on the
   * legacy `{state, update}` props pattern. To be replaced by per-slice
   * selectors when Phase 3 lands. */
  updateState: (updater: WizardState | ((state: WizardState) => WizardState | Partial<WizardState>)) => void;
  reset: () => void;
  /** Internal — used by the user-scope subscriber when the active
   * user changes. Clears in-memory state + caches without bumping
   * wizardEpoch so a hydrate from the new scope's storage can land
   * cleanly on top. Not for app code. */
  _resetForScopeChange: () => void;
  /** Set the voice clone cache. See `voiceCloneCache` below for the
   * mode-swap recovery contract. Pass null to clear. */
  setVoiceCloneCache: (
    cache: { sample: VoiceCloneSample; pendingName: string } | null,
  ) => void;
  /** Set the voice tts cache. See `voiceTtsCache` below. */
  setVoiceTtsCache: (
    cache: { voiceId: string; voiceName: string | null } | null,
  ) => void;
}

/** Ephemeral mode-swap cache for the clone tab. The wizard voice slice
 * is a discriminated union over `source`, so when the user toggles
 * "목소리 고르기" → "새 클론 만들기" the clone-side fields (sample +
 * pendingName) get overwritten by the tts shape. Persisting a snapshot
 * here lets re-entering the clone tab restore the staged file or the
 * cloned voice id. NEVER persisted — clone state is session-scoped. */
export interface VoiceCloneCache {
  sample: VoiceCloneSample;
  pendingName: string;
}

/** Mirror cache for the tts tab — preserves the picked voiceId/voiceName
 * across clone/upload swaps so swapping back to "목소리 고르기" doesn't
 * land on a "목소리 안 골랐어요" state. Auto-populated by setVoice and
 * read by switchAiSubMode on tab swap. */
export interface VoiceTtsCache {
  voiceId: string;
  voiceName: string | null;
}

export type WizardStore = WizardState & WizardActions & {
  voiceCloneCache: VoiceCloneCache | null;
  voiceTtsCache: VoiceTtsCache | null;
};

// ────────────────────────────────────────────────────────────────────
// Legacy migration — read the legacy `showhost_state` key once,
// transform, write under the new key, delete the old. Idempotent:
// after the first load the old key is gone, so re-running no-ops.
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

    // Each slice runs through migrateLegacyToSchema, which translates
    // its bag of optional flat fields into the right tagged-union shape.
    const playlistRaw =
      typeof legacy.playlist_id === 'string'
        ? legacy.playlist_id
        : typeof legacy.playlistId === 'string'
          ? legacy.playlistId
          : null;
    const merged: WizardState = {
      ...INITIAL_WIZARD_STATE,
      host: migrateLegacyToSchema({ host: legacy.host }).host,
      products: migrateLegacyToSchema({ products: legacy.products }).products,
      background: migrateLegacyToSchema({ background: legacy.background }).background,
      composition: migrateLegacyToSchema({ composition: legacy.composition }).composition,
      voice: migrateLegacyToSchema({ voice: legacy.voice }).voice,
      resolution: migrateLegacyToSchema({ resolution: legacy.resolution }).resolution,
      imageQuality: migrateImageQuality(legacy.imageQuality),
      playlistId: playlistRaw,
    };

    // Write to the new key using Zustand's persist envelope shape so
    // the middleware picks it up on first read. Tag with the current
    // persist version so Zustand's own migrate() sees a matching
    // version and skips re-migration.
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
  const cleanHost: Host = persistHost(s.host);
  const cleanComposition: Composition = persistComposition(s.composition);
  const cleanBackground: Background = persistBackground(s.background);
  // localFile rows (transient File handle + blob/data: URL preview)
  // collapse to empty so the user sees a fresh slot to re-upload
  // after reload.
  const cleanProducts: Product[] = s.products.map((p) => {
    if (p.source.kind === 'localFile') {
      return { ...p, source: { kind: 'empty' as const } };
    }
    return p;
  });
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
// Persist envelope migrate fn — exported for tests so we can drive
// shape changes through it directly without a persist round-trip.
//
// Versioned migrations stack: each `if (fromVersion < N)` block lifts
// the blob one schema generation. The final cast is `as unknown as
// WizardState` because TypeScript can't statically verify that the
// staged mutations fully shaped the object — it has, but TS doesn't
// follow side-effects through unknown index access.
// ────────────────────────────────────────────────────────────────────

export function migrateWizardEnvelope(
  persisted: unknown,
  fromVersion: number,
): WizardState {
  if (!persisted || typeof persisted !== 'object') {
    return persisted as WizardState;
  }
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
  if (fromVersion < 8) {
    // Hoist any stray `playlist_id` (snake_case) into the typed
    // top-level field. Prefer an existing camelCase value if both keys
    // happen to coexist. Drop the now-dead top-level `script: string`
    // (voice owns the script via voice.script.paragraphs[]).
    if (typeof p.playlist_id === 'string' && typeof p.playlistId !== 'string') {
      p.playlistId = p.playlist_id;
    }
    delete p.playlist_id;
    delete p.script;
  }
  // Lane C: validate the migrated blob against the canonical persisted
  // schema. If it fails, reset to INITIAL_WIZARD_STATE rather than
  // letting a half-migrated/legacy-corrupted shape reach React (which
  // would crash deep in a step page).
  const parsed = WizardStateSerializedSchema.safeParse(p);
  if (!parsed.success) {
    if (typeof console !== 'undefined') {
      // eslint-disable-next-line no-console
      console.warn(
        '[wizardStore] persisted blob failed schema parse — falling back to INITIAL_WIZARD_STATE',
        parsed.error.issues.slice(0, 5),
      );
    }
    return INITIAL_WIZARD_STATE;
  }
  // Serialized schema narrows the runtime LocalAsset slots; widening
  // back to WizardState is safe.
  return parsed.data as WizardState;
}

// ────────────────────────────────────────────────────────────────────
// Fire the migration exactly once per page load, BEFORE Zustand's
// persist middleware reads storage.
// ────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  migrateLegacyStateOnce();
  // authStore (imported in main.jsx before this module) has already
  // resolved the userScope. Move any pre-scoping global draft into the
  // scoped slot before persist's middleware reads its key.
  migrateGlobalToScopedOnce();
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
          lastSavedAt: Date.now(),
        })),
      setProducts: (updater) =>
        set((s) => ({
          products:
            typeof updater === 'function'
              ? (updater as (p: WizardState['products']) => WizardState['products'])(s.products)
              : updater,
          lastSavedAt: Date.now(),
        })),
      setBackground: (next) =>
        set((s) => ({
          background: typeof next === 'function' ? next(s.background) : next,
          lastSavedAt: Date.now(),
        })),
      setComposition: (next) =>
        set((s) => ({
          composition: typeof next === 'function' ? next(s.composition) : next,
          lastSavedAt: Date.now(),
        })),
      setVoice: (next) =>
        set((s) => {
          const newVoice = typeof next === 'function' ? next(s.voice) : next;
          // Auto-cache mode-side snapshots so a tab swap can restore
          // them. clone cache: source='clone' + non-empty sample.
          // tts cache: source='tts' + voiceId. Either cache only
          // updates while the corresponding mode is active, so old
          // state survives until the user explicitly overwrites it.
          let voiceCloneCache = s.voiceCloneCache;
          let voiceTtsCache = s.voiceTtsCache;
          if (
            newVoice.source === 'clone' &&
            newVoice.sample.state !== 'empty'
          ) {
            voiceCloneCache = {
              sample: newVoice.sample,
              pendingName: newVoice.pendingName,
            };
          }
          if (newVoice.source === 'tts' && newVoice.voiceId) {
            voiceTtsCache = {
              voiceId: newVoice.voiceId,
              voiceName: newVoice.voiceName,
            };
          }
          return {
            voice: newVoice,
            voiceCloneCache,
            voiceTtsCache,
            lastSavedAt: Date.now(),
          };
        }),
      voiceCloneCache: null,
      voiceTtsCache: null,
      setVoiceCloneCache: (cache) => set({ voiceCloneCache: cache }),
      setVoiceTtsCache: (cache) => set({ voiceTtsCache: cache }),
      setResolution: (resolution) => set({ resolution, lastSavedAt: Date.now() }),
      setImageQuality: (imageQuality) => set({ imageQuality, lastSavedAt: Date.now() }),
      setPlaylistId: (playlistId) => set({ playlistId, lastSavedAt: Date.now() }),
      touchLastSavedAt: () => set({ lastSavedAt: Date.now() }),

      updateState: (updater) =>
        set((s) => {
          const next = typeof updater === 'function' ? updater(s) : updater;
          return { ...s, ...next };
        }),

      reset: () =>
        set((s) => ({
          ...INITIAL_WIZARD_STATE,
          wizardEpoch: ((s.wizardEpoch as number | undefined) ?? 0) + 1,
          voiceCloneCache: null,
          voiceTtsCache: null,
        })),

      // Drop in-memory state + caches without bumping wizardEpoch (the
      // scope change itself is the discontinuity, not a fresh wizard).
      // Used by the user-scope subscriber on logout / login as the user
      // changes — clears any draft from the previous user before the
      // next rehydrate decides whether the new scope has its own.
      _resetForScopeChange: () =>
        set(() => ({
          ...INITIAL_WIZARD_STATE,
          voiceCloneCache: null,
          voiceTtsCache: null,
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
      //   v8: WizardState shape reconciled (Lane B.5 / D11). Top-level
      //       `script: string` retired (voice already owns it via
      //       `voice.script`); top-level `playlistId: string | null`
      //       hoisted from a stray `playlist_id` written via the now-
      //       removed `[k:string]: unknown` escape hatch. Lane C adds
      //       `safeParse`-on-hydrate hardening on top.
      version: 8,
      migrate: (persisted, fromVersion) => migrateWizardEnvelope(persisted, fromVersion),
      // Lane C — onRehydrateStorage scrub. After zustand merges the
      // hydrated blob into the live store, run the same transient-state
      // scrub used at save time (streaming / failed → idle for host
      // and composition; generating / failed → idle for voice; clone
      // 'pending' sample → 'empty'). 'ready' is intentionally preserved
      // — selected variants and generated assets are reloadable server
      // paths, not transient streams. Without this, a crashed-mid-
      // stream blob that slipped past partialize would resurrect the
      // 'streaming' state on next page load with no live SSE behind it.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.host = persistHost(state.host);
        state.background = persistBackground(state.background);
        state.composition = persistComposition(state.composition);
        state.voice = persistVoice(state.voice);
      },
    },
  ),
);

// ────────────────────────────────────────────────────────────────────
// Per-slice selector hooks (Phase 3 prereq for Lane D).
//
// Each hook subscribes to one slice via the `useStore(selector)` form
// — a keystroke in Step 3 that updates the script doesn't re-render
// Step 1's host card. `useWizardActions()` returns a stable reference
// to the setter functions; safe to destructure inside a component
// body without triggering re-renders.
// ────────────────────────────────────────────────────────────────────

export const useHost = (): Host => useWizardStore((s) => s.host);
export const useProducts = (): Product[] => useWizardStore((s) => s.products);
export const useBackground = (): Background => useWizardStore((s) => s.background);
export const useComposition = (): Composition => useWizardStore((s) => s.composition);
export const useVoice = (): Voice => useWizardStore((s) => s.voice);
export const useResolution = (): ResolutionKey => useWizardStore((s) => s.resolution);
export const useImageQuality = (): ImageQuality => useWizardStore((s) => s.imageQuality);
export const usePlaylistId = (): string | null => useWizardStore((s) => s.playlistId);
export const useWizardEpoch = (): number => useWizardStore((s) => s.wizardEpoch);
export const useLastSavedAt = (): number | null => useWizardStore((s) => s.lastSavedAt);

export interface WizardActionsRef {
  setHost: WizardActions['setHost'];
  setProducts: WizardActions['setProducts'];
  setBackground: WizardActions['setBackground'];
  setComposition: WizardActions['setComposition'];
  setVoice: WizardActions['setVoice'];
  setResolution: WizardActions['setResolution'];
  setImageQuality: WizardActions['setImageQuality'];
  setPlaylistId: WizardActions['setPlaylistId'];
  touchLastSavedAt: WizardActions['touchLastSavedAt'];
  reset: WizardActions['reset'];
}

/** Stable getter for every slice setter — destructure freely. Reads
 * via `getState()` so the returned object is identity-stable across
 * renders. zustand's setters are created once at store init and never
 * swap, so destructuring this in a component body costs nothing and
 * avoids the "fresh object every render" subscription footgun. */
export function useWizardActions(): WizardActionsRef {
  const s = useWizardStore.getState();
  return {
    setHost: s.setHost,
    setProducts: s.setProducts,
    setBackground: s.setBackground,
    setComposition: s.setComposition,
    setVoice: s.setVoice,
    setResolution: s.setResolution,
    setImageQuality: s.setImageQuality,
    setPlaylistId: s.setPlaylistId,
    touchLastSavedAt: s.touchLastSavedAt,
    reset: s.reset,
  };
}

// ────────────────────────────────────────────────────────────────────
// User-scope re-binding.
//
// When authStore calls setUserScope(user_id) (login / page restore) or
// setUserScope(null) (logout / 401), this subscriber:
//   1. drops in-memory store state — otherwise the previous user's
//      data lingers visibly until the next slice write,
//   2. for a non-null new scope, runs one-shot legacy migration of
//      pre-scoping global keys ('showhost.wizard.v1', '.step.v1')
//      into the new scoped keys (so the only existing user — jack —
//      doesn't lose his draft on the day this lands),
//   3. re-binds the persist middleware's storage `name` to the new
//      scoped key,
//   4. on a non-null scope, calls rehydrate() so the store reflects
//      the new user's persisted draft (or a clean slate if absent),
//   5. on null (logout), purges all owned keys from local + session
//      storage so nothing carries to the next user.
//
// The subscription is module-level — wizardStore evaluating triggers
// the subscribe call exactly once, and the callback runs on every
// scope change for the lifetime of the page.
// ────────────────────────────────────────────────────────────────────

function migrateGlobalToScopedOnce(): void {
  // Move 'showhost.wizard.v1' (legacy global) → storageKey('wizard')
  // (which now resolves with the user_id suffix). Idempotent — once
  // the global key is gone the function no-ops.
  try {
    const scopedWizard = storageKey('wizard');
    const globalWizard = 'showhost.wizard.v1';
    if (scopedWizard !== globalWizard) {
      const existingScoped = localStorage.getItem(scopedWizard);
      const existingGlobal = localStorage.getItem(globalWizard);
      if (existingScoped == null && existingGlobal != null) {
        localStorage.setItem(scopedWizard, existingGlobal);
      }
      // Remove the global copy regardless — once any user has owned
      // this device, the global slot is dead. Subsequent users get
      // their own scoped key, never inherit jack's draft.
      if (existingGlobal != null) localStorage.removeItem(globalWizard);
    }
    const scopedStep = storageKey('step');
    const globalStep = 'showhost.step.v1';
    if (scopedStep !== globalStep) {
      const existingScopedStep = localStorage.getItem(scopedStep);
      const existingGlobalStep = localStorage.getItem(globalStep);
      if (existingScopedStep == null && existingGlobalStep != null) {
        localStorage.setItem(scopedStep, existingGlobalStep);
      }
      if (existingGlobalStep != null) localStorage.removeItem(globalStep);
    }
  } catch {
    /* localStorage unavailable / quota — leave keys as-is */
  }
}

if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  subscribeScope((next, prev) => {
    // 1. Drop previous user's in-memory state.
    useWizardStore.getState()._resetForScopeChange();
    // 2. Wipe storage owned by the user who just left. Done for both
    //    null→user (new login on a device that had a prior session)
    //    and user→user (account swap). When prev is null there's
    //    nothing to wipe — the global slot itself is migrated below.
    if (prev !== null) {
      try {
        for (const k of localStorageKeys(prev)) localStorage.removeItem(k);
        for (const k of sessionStorageKeys(prev)) sessionStorage.removeItem(k);
      } catch { /* storage unavailable */ }
    }
    if (next === null) {
      // Logout: re-bind persist to the new (un-scoped) key but don't
      // rehydrate — there's no signed-in user to load state for.
      // Next setUserScope call will trigger the rehydrate.
      useWizardStore.persist.setOptions({ name: storageKey('wizard') });
      return;
    }
    // 3. Move legacy global draft into the scoped slot before persist
    //    rehydrates from it. No-op if global slot is empty.
    migrateGlobalToScopedOnce();
    // 4. Re-bind persist storage to the new scoped name.
    useWizardStore.persist.setOptions({ name: storageKey('wizard') });
    // 5. Pull the new user's draft from storage. Promise — fire and
    //    forget; subscribers re-render when state lands.
    void useWizardStore.persist.rehydrate();
  });
}

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
