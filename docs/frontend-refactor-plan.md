# Frontend Refactor Plan

**Branch**: `feat/playlists` (continuing on this branch since UI overhaul is in flight)
**Drafted**: 2026-04-26
**Sources**: Codex audit (2026-04-26), accumulated bug pattern from recent UI rebuild

## Why we're refactoring

A series of recent UI bugs all share the same root cause:

- `bg-accent-soft` Tailwind class produced no styles for months because `--color-accent-soft` was missing from `@theme inline` — but no compiler caught it because className strings are unchecked
- `_gradient` and `_file` legacy fields persist in 44 places after their consumers were deleted, because they're optional `any`-typed and no consumer owns removing them
- `ModeCard` was inline-defined in 3 files (BackgroundPicker, Step3Audio, ProductList rembg) before being extracted, because there was no obvious home for it in `components/`
- `state: any` appears 22× because `wizardStore` declares `WizardSlice = Record<string, unknown>` and every consumer re-asserts its own shape
- A queue popover was hand-rolled with `position: absolute` + manual portal + outside-click handlers, despite shadcn `Popover` being available — because there's no convention forcing wrapper components to be the only path
- A "진행 중" sidebar nav linked to `/render` (dispatch-new), not a list of in-flight tasks — labels and routes drifted apart

### Codex's diagnosis (verbatim core)

> There is no real wizard domain model. State shape is oral tradition, not architecture. That explains the recurring bugs.
>
> `_file`, `_gradient`, `imageUrl`, `path`, `uploadPath`, `selectedUrl`, `generated`, `variants` all float through UI, persistence, validation, and backend mapping with no discriminated state machine. Step 2 upload state alone is a bundle of impossible combinations. Stop patching fields. Model each slice as tagged unions.
>
> One structural move: create `src/wizard/schema.ts` as the canonical typed model plus normalizers and API mappers. Store only that model. UI components receive only typed slices. Persistence normalizes once. Backend payloads are produced only from schema helpers.

## Target end state

```
src/
  index.css                       # Tailwind v4 @theme — ALL design tokens live here
  components/                     # The app's design system. Every other dir imports from here.
    ui/                           # shadcn primitives (untouched, but only re-exported through wizard-*)
    wizard-*.tsx                  # Wizard-* wrappers ARE the design system. Banned: direct ui/* imports outside this dir.
    option-card.tsx, segmented.tsx, ...  # Shared composite primitives
  wizard/
    schema.ts                     # NEW. Canonical tagged-union types for host/products/background/composition/voice/resolution.
    normalizers.ts                # NEW. file → state, server response → state, transient → persisted.
    api-mappers.ts                # NEW. state → backend payload (the only place that produces API request bodies).
    validation.ts                 # Replaces routes/wizardValidation.ts. Validates schema.ts types.
    steps/
      step1-host/                 # Was studio/step1/.
      step2-composite/            # Was studio/step2/.
      step3-audio/                # Was studio/step3/.
  routes/                         # Top-level page components only. Wizard layout, top bar, sidebar, login, mypage, etc.
  hooks/                          # Cross-slice hooks (already typed).
  stores/
    wizardStore.ts                # Stores schema.ts types only. Per-slice selectors (useHostSlice, etc). No updateState.
    authStore.ts, queueStore.ts   # Unchanged.
  api/                            # Typed fetch wrappers (already in good shape).
  queue/                          # Was studio/queue/.
  render/                         # Was studio/render/.
  shared/                         # Was studio/shared/. AudioPlayer etc.
```

`studio/` directory deleted. All Icon.jsx references migrated to `lucide-react`. `app.css` reduced to <300 lines (or eliminated) — most styling lives in component files via Tailwind utilities or scoped CSS.

## Phases — concrete, sequenced, independently shippable

Each phase produces a working app at the end. No phase blocks shipping unrelated features.

---

### Phase 0 — Delete verified-dead files (≤30 min)

**Goal**: low-risk cleanup, zero behavior change. Remove the most obviously dead files so the audit is honest.

**Files to delete after `git grep` confirms 0 callers**:
- `src/studio/PreviewPanel.jsx` — confirmed 0 imports
- `src/studio/PhaseMinusOneSpike.jsx` — only its own test imports it
- `src/studio/__tests__/spike.test.jsx` — tests the dead spike

**Acceptance**:
- TypeScript still compiles
- Existing tests still pass (`bun test`)
- `git grep <deleted-name>` returns nothing

---

### Phase 1 — Wizard schema foundation (1-2 sessions)

**Goal**: build the typed domain model alongside (NOT replacing) existing store. Migrations land in Phase 2.

**Deliverables**:

1. `src/wizard/schema.ts`:

```ts
// host slice
export type Host =
  | { state: 'idle' }
  | { state: 'configured'; mode: 'text' | 'image'; input: HostInput }
  | { state: 'streaming'; variants: HostVariant[]; input: HostInput }
  | { state: 'ready'; selected: HostVariant; variants: HostVariant[]; input: HostInput }
  | { state: 'failed'; error: string };

export type HostInput =
  | { kind: 'text'; prompt: string; builder: HostBuilder; negativePrompt?: string }
  | { kind: 'image'; faceRef: AssetRef; outfitRef: AssetRef | null; outfitText: string; faceStrength: number; outfitStrength: number };

// background slice
export type Background =
  | { kind: 'preset'; presetId: string }
  | { kind: 'upload'; ref: AssetRef }
  | { kind: 'url'; url: string; preview: string | null }
  | { kind: 'prompt'; prompt: string };

// products slice
export type Products = Product[];
export type Product =
  | { id: string; state: 'empty' }
  | { id: string; state: 'localFile'; file: File; previewUrl: string }
  | { id: string; state: 'uploaded'; ref: AssetRef; name?: string }
  | { id: string; state: 'url'; url: string };

// composition slice
export type Composition =
  | { state: 'idle'; settings: CompositionSettings }
  | { state: 'streaming'; settings: CompositionSettings; variants: CompositionVariant[] }
  | { state: 'ready'; settings: CompositionSettings; selected: CompositionVariant; variants: CompositionVariant[] };

// voice slice
export type Voice =
  | { source: 'tts'; voiceId: string | null; voiceName: string | null; advanced: VoiceAdvanced; script: Script; result: VoiceResult }
  | { source: 'clone'; sample: AssetRef | null; clonedVoiceId: string | null; advanced: VoiceAdvanced; script: Script; result: VoiceResult }
  | { source: 'upload'; uploaded: AssetRef | null; script: Script };

// resolution slice
export type Resolution = '448p' | '480p' | '720p' | '1080p';

// shared
export interface AssetRef { path: string; url?: string; name?: string }
export interface HostVariant { seed: number; imageId: string; url: string; path: string }
// ... etc
```

2. `src/wizard/normalizers.ts`:
   - `fromUploadResult(file: File, server: UploadResult): AssetRef`
   - `toPersistable(state: WizardState): PersistedWizard` (drops File handles, blob URLs)
   - `fromPersisted(raw: unknown): WizardState` (validates + migrates legacy)

3. `src/wizard/api-mappers.ts`:
   - `toHostGenerateRequest(host: Host): HostGenerateInput`
   - `toCompositeGenerateRequest(state: WizardState): CompositeGenerateInput`
   - `toRenderRequest(state: WizardState): RenderRequest`
   - These are the ONLY place that produces backend payloads.

**Acceptance**:
- New files exist and compile.
- No consumer migrated yet — the existing store is unchanged.
- Unit tests for the normalizers cover the migrate-legacy path.

---

### Phase 2 — Slice migration (3 sub-phases, one slice per session)

**Strategy**: pick the slice whose tagged-union win is biggest, migrate it first, prove the pattern works, then sweep the rest.

#### Phase 2a — Background (smallest, cleanest win)

Background has 4 sub-modes (preset/upload/url/prompt) currently flattened into one optional-everything object. The tagged union turns 16+ impossible combinations into 4 valid states.

**Steps**:
1. Change `wizardStore.background` field type to `Background` (from schema).
2. Update `setBackground` to accept `Background | (prev: Background) => Background`.
3. Update `BackgroundPicker.tsx` to consume + emit `Background`.
4. Update `Step2Composite.tsx` to read `Background` for bgReady check.
5. Update `wizardValidation.ts` to use schema.
6. Update `api-mappers.ts` `toCompositeGenerateRequest` to use schema instead of pulling fields from raw object.
7. Update `wizardStore` `partializeForPersist` to use `toPersistable`.
8. Delete `_gradient`, `_file`, `imageUrl`, `serverFilename`, `uploadPath`, `preset`, `url`, `prompt`, `source` flat fields from background.
9. Verify Step 2 end-to-end in browser — all 4 sub-modes work, refresh restores state.

**Acceptance**:
- TS compiler enforces background shape correctness across all consumers.
- 0 `state: any` references for background-related code.
- Browser test: switch through all 4 sub-modes, generate composite, refresh page — selection persists.

#### Phase 2b — Host

Same pattern. Drop `_gradient`, `imageUrl` aliasing, `selectedImageId`-vs-`imageId` inconsistency, `selectedPath`-vs-`path` inconsistency.

#### Phase 2c — Remaining slices (products, composition, voice, resolution)

products and voice get the most win (each has 3-way sub-mode). composition and resolution are smaller cleanup.

---

### Phase 3 — Per-slice selectors, kill `updateState`

**Goal**: stop subscribing to whole store. Each step page reads only its slice.

**Steps**:
1. Add per-slice selectors in `wizardStore.ts`:
   ```ts
   export const useHost = () => useWizardStore((s) => s.host);
   export const useBackground = () => useWizardStore((s) => s.background);
   // ... etc
   export const useWizardActions = () => useWizardStore(
     (s) => ({ setHost: s.setHost, setBackground: s.setBackground, ... }),
     shallow
   );
   ```
2. Migrate Step1Host to use `useHost()` + `setHost` action directly. Drop the `{state, update}` props.
3. Same for Step2Composite, Step3Audio.
4. Update WizardLayout to compute validity via `useWizardStore((s) => computeValidity(s))` selector (not whole-store + recompute on every change).
5. Delete `updateState` from store + the legacy callback pattern in StepPages.
6. Delete the legacy `{state, update}` prop interface comments in step1/2/3 file headers.

**Acceptance**:
- StepPages.tsx ≤ 50 lines (was 200+).
- 0 `update((s: any) => …)` callbacks anywhere.
- No `WizardSlice = Record<string, unknown>`. Every store field is typed.

---

### Phase 4 — Wrapper layer policy

**Decision**: `Wizard*` components ARE the design system. Direct `@/components/ui/*` imports outside `src/components/` are banned.

**Rationale**:
- Currently it's both — half the code uses `WizardButton`, half uses `Button` directly. Both exist as imports in the same file sometimes (`Button as ShadButton` aliasing).
- Picking ONE convention removes the cognitive overhead.
- Wrappers can apply project-specific styling + a11y defaults centrally.

**Steps**:
1. Audit imports: `grep -rn "from '@/components/ui/" src --include="*.tsx" | grep -v "src/components/"`.
2. For each external usage, route through a `Wizard*` wrapper. If a wrapper doesn't exist for that primitive (e.g. `Popover`, `Tooltip`), create it.
3. Add a comment in `components/index.ts` (or a CONVENTIONS.md) declaring the rule.
4. Optional: ESLint rule `no-restricted-imports` enforcing the boundary.

**Acceptance**:
- Outside `src/components/`, only `@/components/wizard-*` and shared composites are imported.
- 0 `Button as ShadButton` style aliasing.

---

### Phase 5 — Icon.jsx → lucide-react migration

27 callers. Build a name-to-lucide mapping table, sweep all consumers.

**Steps**:
1. Catalogue every `<Icon name="..." />` invocation and its lucide equivalent.
2. Replace each call site (mostly mechanical).
3. Delete `studio/Icon.jsx` + any sprite/svg assets it used.

**Acceptance**:
- `git grep "from.*studio/Icon"` returns 0.
- Bundle: lucide tree-shake should drop unused icons.

---

### Phase 6 — app.css migration

`app.css` is 1222 lines / 256 hand-written classes alongside Tailwind v4 + shadcn. Mostly Korean Productivity tokens that should live in `@theme`, plus per-component class names that should live in component files.

**Steps**:
1. Categorize each class: (a) design token (e.g. `--accent-soft` token references), (b) component-internal layout, (c) legacy/unused.
2. Move (a) into `index.css` `@theme inline` so Tailwind utilities (`bg-accent-soft`) work out of the box.
3. Move (b) into the component file via either:
   - Tailwind utility classes inline (preferred for simple cases)
   - Component-scoped CSS module (e.g. `Step1Host.module.css`) for complex layout
4. Delete (c).
5. Goal: `app.css` ≤ 300 lines with only truly cross-cutting rules (e.g. `.studio-root` data attributes, theme overrides).

**Acceptance**:
- `wc -l app.css` ≤ 300.
- 0 inline `style={{...}}` blobs that could be Tailwind classes (180 → ≤30).

---

### Phase 7 — studio/ reorganization

`studio/` currently means "old + new I haven't classified". Move active code out, delete the directory.

**Moves**:
| From | To |
|---|---|
| `src/studio/queue/` | `src/queue/` |
| `src/studio/render/` | `src/render/` |
| `src/studio/step1/` | `src/wizard/steps/step1-host/` |
| `src/studio/step2/` | `src/wizard/steps/step2-composite/` |
| `src/studio/step3/` | `src/wizard/steps/step3-audio/` |
| `src/studio/shared/` | `src/shared/` |
| `src/studio/ResultPage.tsx` | `src/routes/ResultPage.tsx` |
| `src/studio/QueueStatus.tsx` | `src/queue/QueueStatus.tsx` |
| `src/studio/ServerFilePicker.jsx` | `src/components/server-file-picker.tsx` (also convert to TS) |
| `src/studio/ErrorBoundary.jsx` | `src/components/error-boundary.tsx` |
| `src/studio/picker_handler.js` | inline into Step2Composite or move to `src/wizard/utils/`  |
| `src/studio/RenderHistory.jsx` | `src/render/RenderHistory.tsx` |
| `src/studio/ProvenanceCard.jsx` | `src/render/ProvenanceCard.tsx` |
| `src/studio/styles/app.css` | already addressed in Phase 6; final remnant moves to `src/index.css` or component files |
| `src/studio/styles/tokens.css` | merge into `src/index.css` `@theme inline` |
| `src/studio/api.js` | DELETE (already a thin re-export shim — migrate consumers to `src/api/*` directly) |

**Acceptance**:
- `src/studio/` deleted entirely.
- `git grep 'from.*studio'` returns 0 (excluding deleted file lookups).

---

## Risk + sequencing

- Phases 0, 4, 5, 6, 7 are **mechanical** — each is mostly find-and-replace with type checks. Low risk per session.
- Phases 1, 2 are **architectural** — they change runtime semantics of state shape. Higher risk, must be tested in browser at each slice migration.
- Phase 3 is **medium** — selector migration is straightforward but touches every step page.

**Recommended order**: 0 → 1 → 2a → 2b → 2c → 3 → 5 → 4 → 6 → 7.

Phase 5 before 4 because Icon migration eliminates one wrapper concern (the duplicate icon system) before the wrapper policy phase.

Phase 7 last because it's just file moves once the actual architecture is fixed — moving them earlier just creates churn before the refactor is done.

## Out of scope

- Backend changes. The schema/api-mappers produce the same wire format the backend expects today.
- Test framework changes. We add unit tests for new normalizers/mappers but don't restructure the suite.
- New features. This is pure refactor — same behavior, less rot.

## Done criteria

- `state: any` count → 0
- `_gradient`, `_file` legacy fields → 0
- `studio/` → deleted
- `app.css` → ≤ 300 lines
- `Icon.jsx` → deleted
- All wizard slices typed via tagged unions
- `WizardSlice = Record<string, unknown>` removed
- `updateState` removed
- 0 direct `@/components/ui/*` imports outside `src/components/`
