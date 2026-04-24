# Frontend Refactor Plan

**Date**: 2026-04-24 (post `/plan-eng-review` + Codex outside voice)
**Stack**: React 19 + Vite 6 + react-router-dom v7 + Vitest
**Scope**: `frontend/src/` + a narrow slice of `app.py` for Pydantic `response_model`s
**Goal**: Turn a working-but-brittle codebase into one that can absorb new features without 3-file edits per change.

**Decisions captured during review** (see §6 for full Decisions Log):
1. `variants` stay in `wizardStore` (preserves current "survives reload" UX and the "retry picks fresh seeds" logic).
2. Full Tailwind v4. Recurring visual patterns become React components (extend `primitives.jsx`), NOT CSS classes. `app.css` reduced to `:root` design tokens only.
3. `openapi-typescript` from Phase 0 **AND** a backend slice adding Pydantic `response_model`s to the endpoints the frontend reads (`/api/queue`, `/api/results/:id`, `/api/tasks/:id/state`, `/api/history`, `/api/hosts/candidates`). Without response models the generated types are useless.
4. Legacy `localStorage.showhost_state` → Zustand persist migration is a **mandatory regression test** in Phase 2 (matched by `ErrorBoundary`'s escape hatch moving to the new keys).
5. `wizardStore` + `queueStore` both via Zustand — consistency over Codex's "queueStore overengineered" critique, for selector ergonomics and one mental model.
6. ~~Wizard store slice includes `rendering` + `attachToTaskId`~~ — **superseded by decision #10**: URL is the source of truth for current screen, so these fields are not needed in the store.
7. Concurrency: every async hook uses **AbortController + request-epoch** guards (stale-result rejection). Covers StrictMode double-invocation AND "old upload arrives after user made a newer choice".
8. Phase 4 prereq: move global style imports (`tokens.css`, `tailwind.css`) from `HostStudio.jsx` to `main.jsx` so `/result/:taskId` works on a cold open. Current behavior requires visiting `/` first.
9. Phase 7 E2E estimate revised: **3–4 days** (was 1.5). Playwright harness needs a fixture backend for uploads/SSE/queue/manifest flows — that's real work.
10. **Per-step routing + dedicated render route** (new): `/step/:n`, `/render/:taskId`, `/result/:taskId`. Fixes "refresh on Step 2 → random step", "refresh mid-render → back to Step 3" UX bugs; dissolves dispatch/attach code paths (both navigate to `/render/:taskId`); makes render view mentally distinct from Step 3.
11. **Extensibility slots (E1–E6, new)**: design for login/multi-user/full Tasks page without building them now.
    - E1: nested layout routes (`<AppLayout>` wraps app routes; `<AuthLayout>` slot reserved for `/login`, `/signup` later).
    - E2: `http.ts` carries an auth-header provider (noop today, `() => ({Authorization: ...})` when auth lands).
    - E3: Zustand persist key factory — `storageKey('wizard')` returns `'showhost.wizard.v1'` today, `'showhost.wizard.v1.{userId}'` when auth lands.
    - E4: `<TaskRow>` extracted as a standalone reusable component (not dropdown-coupled) — seeds the future `/tasks` page.
    - E5: Queue panel gets a "모두 보기 →" link to `/tasks` (placeholder route, renders "준비 중" today).
    - E6: Reserved routes — `/step/:n`, `/render/:taskId`, `/result/:taskId`, `/tasks`, `/login`, `/signup`, `/profile`. Lock the shapes now; implement `/login` etc. later.

---

## 1. Current State (from audit)

| Area | Grade | Worst offenders |
|---|---|---|
| Component size | F | Step2Composite (694 LOC), RenderDashboard (~27KB), Step1/Step3 (~500 LOC each) |
| State mgmt | D | Dual source of truth (`job` local + `queueEntry` context + localStorage); prop drilling |
| API layer | C- | `api.js` 620 LOC flat, 2 direct `fetch` callsites bypass it, **no AbortController anywhere** |
| Types | F | Zero JSDoc/PropTypes/TS; wizard state shape only in `INITIAL_STATE` |
| Styling | D | 88+ inline `style={{…}}` duplicating CSS class concepts |
| Testing | C | Pure mappers over-covered; Step components + SSE paths have zero tests |
| Concurrency | D- | No AbortController; stale closures possible on fast remounts |

Full audit in conversation history; not repeated here.

---

## 2. Target Architecture (end state)

```
frontend/src/
├── App.jsx                    # router + store providers only
├── types/
│   ├── generated/api.d.ts     # openapi-typescript output
│   └── app.d.ts               # hand-written UI-only types
├── api/                       # one file per domain, AbortSignal-first
│   ├── http.ts                # fetchJSON + ApiError + auth-header provider (E2)
│   ├── host.ts
│   ├── composite.ts
│   ├── voice.ts
│   ├── queue.ts
│   ├── result.ts
│   ├── file.ts
│   └── progress.ts            # task polling (subscribeProgress)
├── stores/
│   ├── queueStore.ts          # Zustand + useSyncExternalStore poll
│   ├── wizardStore.ts         # Zustand + persist (storageKey factory — E3)
│   └── storageKey.ts          # storageKey('wizard') → user-scoped when auth lands (E3)
├── hooks/
│   ├── useHostGeneration.ts
│   ├── useCompositeGeneration.ts
│   ├── useVoiceList.ts
│   ├── useTTSGeneration.ts
│   ├── useVoiceClone.ts
│   └── useRenderJob.ts
├── layouts/                   # E1
│   ├── AppLayout.jsx          # TopBar + <Outlet />  (current HostStudio shell)
│   └── AuthLayout.jsx         # minimal shell for /login, /signup — empty today
├── routes/                    # route-level components, one per URL segment
│   ├── IndexRoute.jsx         # "/" redirector (to active render/result or /step/1)
│   ├── WizardStep.jsx         # "/step/:n" — reads n, renders Step1/2/3 from ../studio
│   ├── RenderPage.jsx         # "/render/:taskId" — thin wrapper around RenderDashboard
│   ├── ResultPage.jsx         # "/result/:taskId" — uses router loader
│   ├── TasksComingSoon.jsx    # "/tasks" placeholder (E5, E6)
│   └── NotFound.jsx           # catch-all
├── studio/                    # pure UI components, no fetch, no routing
│   ├── step1/                 # decomposed Step 1
│   ├── step2/
│   ├── step3/
│   ├── render/                # RenderDashboard + ProgressCard + StageChecklist
│   ├── result/                # ResultVideoCard, ResultActions, ResultStats
│   ├── queue/                 # QueueTrigger, QueuePanel, TaskRow (E4)
│   └── shared/                # Confetti, ProvenanceCard, Card, StepPill, AudioPlayer
├── styles/
│   ├── tokens.css             # design tokens — imported from main.jsx (Decision #8)
│   └── tailwind.css           # @import "tailwindcss"; @theme { … tokens … }
└── main.jsx                   # imports both CSS files globally
```

### Route tree

```
<Routes>
  <Route element={<AppLayout />}>               {/* TopBar + Outlet */}
    <Route index element={<IndexRoute />} />    {/* "/" → redirect */}
    <Route path="step/:n" element={<WizardStep />} />
    <Route path="render/:taskId" element={<RenderPage />} />
    <Route
      path="result/:taskId"
      loader={resultLoader}                      {/* Phase 5 */}
      errorElement={<ResultNotFound />}
      element={<ResultPage />}
    />
    <Route path="tasks" element={<TasksComingSoon />} />  {/* E5 placeholder */}
    <Route path="*" element={<NotFound />} />
  </Route>
  <Route element={<AuthLayout />}>              {/* E1 slot — empty today */}
    {/* /login, /signup, /reset-password go here later */}
  </Route>
</Routes>
```

**Tailwind v4** via `@tailwindcss/vite` with `@theme` bridging existing CSS custom properties (`--bg`, `--accent`, `--r-sm` → `bg-bg`, `text-accent`, `rounded-r-sm`). Hand-written classes in `app.css` stay (they compose fine with utilities); all inline `style={{…}}` become Tailwind utilities.

**Key library choices (with rationale from research)**:
- **Zustand** replaces Context+useState everywhere the state matters. Selector-based subscriptions fix re-render storms; `persist` middleware replaces the hand-rolled localStorage effect; fewer providers in the tree.
- **`useSyncExternalStore`** is the underpinning for the queue poll (tear-free reads, works outside React too).
- **Tailwind v4** for styles; bridged to existing tokens so Day-1 visual diff is zero.
- **react-router v7 `loader`** used in three narrow places: `/result/:taskId` (collapses fetch+loading+404), `/` (smart redirect based on queue state), and `/step/:n` (guard redirects to first incomplete step). Wizard step bodies stay imperative inside — loaders only gate entry.
- **Skip**: React 19 `use()` for SSE (SSE wants `useSyncExternalStore`, not promises), `useActionState`/`useOptimistic`/`useFormStatus` (this isn't form submission), Jotai/Panda/vanilla-extract (overkill at this size).

---

## 3. Phase Ordering & Dependency Graph

```
Phase 0: Toolchain + BE  ─┐
                          ├──► Phase 1: API layer ──┐
                          │                         ├──► Phase 3: Hooks ──► Phase 4: Decompose + Tailwind
                          └──► Phase 2: Stores ─────┘                       │
                                                                            ▼
                                                                Phase 5: Route tree overhaul
                                                                (per-step + /render + layouts + loader)
                                                                            │
                                                                            ▼
                                                                Phase 6: Test gaps filled (Playwright + hooks + stores)

(Phase 6 is opportunistic — can run alongside any phase once the surface it covers stabilises.)
```

Rule of thumb: **nothing in Phase N+1 starts until Phase N is merged and tests green**. Each phase is sized so every merge leaves the app fully functional — no broken intermediate states on `main`.

---

## 4. Phases

### Phase 0 — Toolchain + backend type prereq (NO frontend runtime change)

**Goal**: Land TypeScript, ESLint, Prettier, Tailwind v4, `openapi-typescript` codegen — AND give the frontend's top-read endpoints real response models so the codegen produces useful types. Frontend UI identical on Day 0.

**Prereqs**: none.

**Tasks** (frontend):
- `tsconfig.json` with `allowJs: true`, `strict: true`, `noUncheckedIndexedAccess: true`, `jsx: "react-jsx"`.
- `src/types/generated/api.d.ts` — generated by `openapi-typescript http://localhost:8001/openapi.json -o src/types/generated/api.d.ts`. Run via `npm run gen:types`.
- `src/types/app.d.ts` — hand-written types that COMPOSE generated ones (`WizardState`, UI-only shapes, Product draft vs Product saved).
- `eslint.config.js` (flat config): `react`, `react-hooks`, `@typescript-eslint`, `jsx-a11y`. Warnings for `any`/unused vars; ratchet later.
- `prettier.config.js` + `.prettierignore` (dist, node_modules).
- Tailwind v4 via `@tailwindcss/vite`:
  - `npm i -D tailwindcss @tailwindcss/vite zustand`
  - Add `@tailwindcss/vite` to `vite.config.js` plugins.
  - New `styles/tailwind.css`: `@import "tailwindcss";` + `@theme { --color-bg: var(--bg); /* … one line per token */ }`.
  - **Move global imports** (`tokens.css`, `tailwind.css`) from `HostStudio.jsx` to `main.jsx` so every route (incl. `/result/:taskId`) gets styling on a cold open. `app.css` stays imported from `HostStudio` for now (Phase 4 thins it).
- CI hook: `npm run check` = `tsc --noEmit` + `eslint` + `vitest run` + `gen:types` (verifies committed types match backend).

**Tasks** (backend — narrow slice):
- Add Pydantic `response_model=` (or explicit return type annotations FastAPI can introspect) to the endpoints the frontend reads:
  - `/api/queue` → `QueueSnapshot { running, pending, recent, total_running, total_pending }` with `QueueEntry { task_id, type, label, status, created_at, started_at?, completed_at?, error?, … }`.
  - `/api/results/:task_id` → `ResultManifest { task_id, type, status, generation_time_sec?, video_url, video_path?, video_bytes, params, meta?, synthesized? }`.
  - `/api/tasks/:task_id/state` → `TaskState { task_id, stage, progress, message, error?, output_path? }`.
  - `/api/history` → `{ total: int, videos: list[VideoHistoryItem] }`.
  - `/api/hosts/candidates` stream event envelope — as a standalone `HostCandidateEvent` union.
- These models are backend-only; Python side unchanged in behavior. Just makes the schema honest so `openapi-typescript` produces real types.

**Files touched**:
- New: `frontend/tsconfig.json`, `eslint.config.js`, `prettier.config.js`, `styles/tailwind.css`, `src/types/app.d.ts`.
- Modified: `frontend/vite.config.js` (plugin), `frontend/src/main.jsx` (imports), `frontend/package.json` (deps + `gen:types` script), `app.py` (response_model decorators + Pydantic model declarations — ~100 lines additive).

**Validation**: existing 105 vitest tests pass; `tsc --noEmit` clean (with `allowJs`); `npm run gen:types` clean; app runs and looks identical; `/result/:task_id` opened in a fresh tab loads styled.

**Rollback**: revert config commits. Frontend code untouched. Backend additions don't change response bodies.

**Risk**: LOW for frontend; LOW for backend if response models match existing return shapes exactly. Mitigation: run current backend tests after adding response models — any field rename would fail there.

**Size**: 1 day (0.5 frontend toolchain + 0.5 backend response_model slice).

---

### Phase 1 — API Layer (AbortSignal-first, domain-split)

**Goal**: `src/api/*.ts` with every call accepting `{ signal?: AbortSignal }`. Direct `fetch` calls removed from `ResultPage` and `RenderDashboard`. Existing `api.js` becomes a re-export shim during migration, then is deleted at the end of the phase.

**Prereqs**: Phase 0 (types + Tailwind installed but unused).

**Tasks**:
1. Create `src/api/http.ts`:
   - `fetchJSON<T>(url, { signal, ...init })` → throws typed `ApiError` (status + parsed body).
   - `humanizeError(err: unknown): string` moved here.
   - `API_BASE` + header helpers.
   - **Auth header provider (E2)**: `type AuthHeaderProvider = () => Record<string, string>; let authProvider: AuthHeaderProvider = () => ({}); export function setAuthProvider(p: AuthHeaderProvider) { authProvider = p; }`. `fetchJSON` merges `authProvider()` into headers on every request. Today returns `{}` (noop); when `/login` lands, `authStore` calls `setAuthProvider(() => ({Authorization: 'Bearer ' + token}))` once at boot.
2. Create domain modules by slicing `api.js` (grep by section comment):
   - `host.ts` — `generateHostCandidates`, `streamHostCandidates`, `uploadReferenceImage`.
   - `composite.ts` — `generateComposite`, `streamComposite`, `uploadProductImage`, `uploadBackgroundImage`.
   - `voice.ts` — `listVoices`, `cloneVoice`, `generateTTS`, `uploadAudio`.
   - `queue.ts` — `fetchQueue`, `cancelQueuedTask`.
   - `result.ts` — `fetchResult` (new — replaces direct `fetch` in ResultPage).
   - `file.ts` — `getVideoMeta` (HEAD), `listServerFiles`, signed URL helpers.
   - `progress.ts` — `subscribeProgress` (current polling impl, now with `signal` + returns unsubscribe that also aborts).
3. Convert each stream helper to take `signal`:
   - `streamHostCandidates({ …, signal })` — pass to `fetch(url, { signal })` and to the reader loop.
   - Same for `streamComposite`.
4. Port `ResultPage` and `RenderDashboard` direct fetches to `result.ts`/`file.ts`.
5. Rewrite `api.js` to be 5 lines: `export * from './api/...'` so no component needs immediate refactor.
6. Tests: upgrade `api.test.js` — add `AbortController` cancel tests per domain (abort during stream, abort during HEAD).

**Files touched**:
- New: `src/api/{http,host,composite,voice,queue,result,file,progress}.ts`.
- Modified: `src/studio/ResultPage.jsx` (one line), `src/studio/RenderDashboard.jsx` (one line), `src/studio/api.js` (shrinks to re-exports).

**Validation**: 105 tests remain green. New tests cover abort paths. Visual smoke test on dev: Step1 cancel/regenerate mid-stream no longer stacks.

**Rollback**: revert the domain split. Direct-fetch removals stand (cheap).

**Risk**: MEDIUM. Signature churn across many callsites. Mitigation: keep re-export shim in `api.js` so no component imports change until Phase 4.

**Size**: 1.5 days.

---

### Phase 2 — Stores (Zustand + useSyncExternalStore)

**Goal**: Single source of truth for queue state and for wizard state. Delete `QueueContext` and the hand-rolled localStorage effect.

**Prereqs**: Phase 0 (types), Phase 1 (api.queue for polling).

**Tasks**:
1. `npm i zustand`.
2. `src/stores/queueStore.ts`:
   - Zustand store `{ data: QueueSnapshot|null, error, lastFetchedAt }`.
   - Poll lifecycle in the store (not a component): `start()` / `stop()` count subscribers; poll runs only when > 0. `useSyncExternalStore`-powered hook `useQueueStore(selector)`.
   - Rebuild existing hook surface: `useQueue()`, `useQueueEntry(taskId)`, `useQueuePosition(taskId)` — same signatures so consumers don't change yet.
   - Delete `QueueContext.jsx` once all consumers read from the store. (Move `QueueProvider` out of `App.jsx`.)
3. `src/stores/wizardStore.ts`:
   - State: `{ host, products, background, composition, voice, script, resolution, imageQuality }` — typed from Phase 0. No `step`/`rendering`/`attachToTaskId` — those live in the URL now (Phase 5 + Decision #10).
   - `host.variants`, `composition.variants` stay in the store (not transient) — preserves current reload-survival behavior and the retry-picks-fresh-seeds logic.
   - Actions: `setHost(partial)`, `setProducts(fn)`, `setBackground(partial)`, `setComposition(partial)`, `setVoice(partial)`, `reset()`.
   - `persist` middleware with custom `partialize` that drops transient fields (`_file`, blob URLs) at save time — **one-way**, no bidirectional sanitize/hydrate.
   - **Storage key via factory (E3)**: `persist({ name: storageKey('wizard'), … })` where `storageKey(suffix) => 'showhost.' + suffix + '.v1'` today. Signature takes a future `userId` argument; authStore injects it when auth lands, producing `'showhost.wizard.v1.{userId}'`.
4. **Legacy migration** (mandatory, Codex #10):
   - On store init: if `localStorage.showhost_state` exists, read it, transform into the Zustand shape, write under the new key, delete the old key. One-shot, idempotent.
   - Update `ErrorBoundary.jsx:20` so its "clear storage" escape hatch also knows about the new keys (it currently only clears legacy keys).
   - **Regression test (mandatory)**: seed `localStorage` with a legacy payload, mount `App`, assert state is hydrated correctly AND old key is gone.
5. RenderDashboard: delete the local `job` state block. Replace with `const entry = useQueueEntry(taskId)` + UI-only `useState` for elapsed ticker. Progress stage/message come from `useRenderJob` (Phase 3). Dispatch-vs-attach branch simplification waits until Phase 5 (when the URL supplies `taskId`); for now keep both code paths but have them read from the store.
6. HostStudio: keep the shell component alive — just replace its `useState(INITIAL_STATE)` + `update` callback with `useWizardStore(selector)` per slice; drop `sanitizeForPersist` / `hydrateState` (the persist middleware owns that now). `?attach=` URL effect stays in HostStudio for now; Phase 5 deletes it along with the component itself.
7. Tests: migrate `state_persist.test.js` to assert `persist` middleware behavior (including transient-field drop); migrate `queue_context.test.jsx` to exercise store selectors; new `legacy_migration.test.js` for the one-shot migration.

**Files touched**:
- New: `src/stores/queueStore.ts`, `src/stores/wizardStore.ts`, `src/stores/storageKey.ts`.
- Deleted: `src/studio/QueueContext.jsx` (once all consumers migrate).
- Modified: `App.jsx` (remove QueueProvider), `HostStudio.jsx` (state → store selectors; component itself stays until Phase 5), `RenderDashboard.jsx`, `QueueStatus.jsx`, `RenderHistory.jsx`, `ErrorBoundary.jsx` (update storage keys), tests.

**Validation**: existing tests pass (migrated ones updated), manual smoke test — reload page mid-wizard, state restores; QueueStatus still updates every 4s; RenderDashboard elapsed ticker works.

**Rollback**: keep old `QueueContext.jsx` / `sanitizeForPersist` next to the new files until Phase 4 lands, then delete.

**Risk**: MEDIUM-HIGH. Touches two high-traffic components (HostStudio, RenderDashboard). Mitigation: do queueStore first (smaller blast radius, tests cover it well), wizardStore second.

**Size**: 2 days.

---

### Phase 3 — Custom Hooks for Async Flows

**Goal**: Each async domain is a hook that owns its AbortController, exposes `{ loading, error, result, run, abort }`, and consumes `src/api/*`. Wizard steps shrink to glue code.

**Prereqs**: Phase 1 (api with signal), Phase 2 (stores for persisted state).

**Concurrency contract (applies to every hook below)**:

Each async hook uses two layers of stale-result protection, because `AbortController` alone does NOT cover every race (Codex #5):

1. **AbortController** — aborts the in-flight `fetch`/SSE when the hook unmounts or the caller explicitly starts a new operation.
2. **Request epoch** — each `run()`/`regenerate()` increments a ref'd counter. Results carry their epoch; `setState` is guarded by `if (resultEpoch !== currentEpoch) return;`. Covers:
   - React 18 StrictMode double-invocation (current `RenderDashboard.jsx:167, 205` one-shot guards).
   - "Old upload resolves AFTER the user changed their mind and started a new one" (current `Step1Host.jsx:110`, `Step2Composite.jsx:169` stale-write risk).
   - Server takes longer than user's patience → cancel+retry → server responds to old request first.

**Tasks**:
1. `hooks/useHostGeneration.ts`:
   - Inputs: current wizard host slice (selector).
   - Exposes: `{ variants, loading, error, regenerate(seeds?), abort() }`.
   - Internal: AbortController + epoch ref; subscribes via `api.host.streamHostCandidates({ signal })`; variants flow through `wizardStore.setHost({ variants })` (NOT transient — see §2 decision #1).
2. `hooks/useCompositeGeneration.ts` — same shape, for `api.composite.streamComposite`. Variants in `wizardStore.setComposition({ variants })`.
3. `hooks/useVoiceList.ts` — one-shot fetch, abort on unmount, epoch-guarded.
4. `hooks/useTTSGeneration.ts`, `hooks/useVoiceClone.ts` — same pattern.
5. `hooks/useRenderJob.ts`:
   - Input: `taskId`.
   - Output: `{ entry, progress, stage, message, elapsedMs, isDone, isError }`.
   - Combines `useQueueEntry` + `api.progress.subscribeProgress`. Single hook replaces the two overlapping state machines in RenderDashboard. Internal polling also uses AbortController for unmount cleanup.
6. `hooks/useUploadReferenceImage.ts` (or similar) — extract the upload+set-path pattern currently inlined in Step1/Step2 so stale-result rejection is enforced in one place.
7. Tests: mock `api.*` modules; per hook: (a) abort called on unmount, (b) stale epoch responses dropped (spawn two `run()`s in quick succession, assert only the second's result is committed).

**Files touched**:
- New: `src/hooks/*.ts`.
- No component changes yet — hooks are unused until Phase 4.

**Validation**: new hook tests pass; hooks import cleanly from stores and api.

**Rollback**: delete the new hook files.

**Risk**: LOW. Hooks are additive; old code paths in components still work.

**Size**: 1.5 days.

---

### Phase 4 — Component Decomposition + shared-component styling (uses Phase 3 hooks)

**Goal**: No component over ~200 LOC. Step1/2/3 become thin containers; sub-components do one thing. Recurring visual patterns become React components in `primitives.jsx` (NOT CSS classes — per decision #2); inline `style={{...}}` disappears entirely.

**Prereqs**: Phase 3 (hooks ready).

**Reality check** (per Codex #7): `styles/app.css` is ~31KB of shared selectors (`.card`, `.step-pill`, `.voice-row`, `.audio-player`, etc.). "Reduce to tokens only" is a meaningful rewrite, not a cleanup — the shared patterns become `<Card>`, `<StepPill>`, `<VoiceRow>`, `<AudioPlayer>` components with Tailwind utilities inside. This work lives in Phase 4 and is the bulk of its time budget.

**Strategy**: one component per sub-PR, each with the same skeleton:

```
studio/step2/
├── Step2Composite.jsx        # thin container (<150 LOC): orchestrates sub-components
├── ProductList.jsx
├── BackgroundPicker.jsx
├── CompositionControls.jsx
├── CompositionVariants.jsx
└── ServerFilePickerModal.jsx # existing, relocated
```

**Decomposition targets**:
- **Step1Host**: → `Step1Host` + `HostReferenceUploader` + `HostGenerationControls` + `HostVariantGrid`.
- **Step2Composite**: → the list above.
- **Step3Audio**: → `Step3Audio` + `VoicePicker` + `VoiceCloner` + `ScriptEditor` + `ResolutionPicker` + `AudioPreview` (the player already exists — just extract).
- **RenderDashboard**: → `RenderDashboard` + `ProgressCard` + `StageChecklist` + `ElapsedBadge`. No more "attach mode" branch — `taskId` always comes from URL (Phase 5 / Decision #10).
- **ResultPage**: → sub-components `ResultVideoCard` + `ResultActions` + `ResultStats` + shared `ProvenanceCard` living in `studio/result/`. The route-level wrapper `routes/ResultPage.jsx` that reads from `useLoaderData()` gets assembled in Phase 5 — Phase 4 just decomposes the existing body.
- **QueueStatus**: → `QueueTrigger` + `QueuePanel` + `QueueSection` + `TaskRow` (E4 — standalone, reusable by future `/tasks` page) + `useQueueActions` (cancel logic). QueuePanel gets a "모두 보기 →" link to `/tasks` (E5 — placeholder route).

**Per-component checklist** (enforce before merge):
- [ ] Under 200 LOC.
- [ ] No direct `fetch`.
- [ ] No `setInterval`/`EventSource` (goes through hook).
- [ ] No `style={{…}}` beyond one-offs that would be absurd as classes (e.g., dynamic width %).
- [ ] TypeScript — file renamed `.tsx` with typed props.
- [ ] One test covering the happy path (snapshot fine for pure render; interaction for buttons).

**Files touched**: ~20 new component files, 6 huge files deleted/replaced.

**Validation**: Playwright happy-path E2E (Phase 7 lays groundwork) catches visual regressions; existing unit tests migrate to new components.

**Rollback**: per-component PR; revert individually.

**Risk**: HIGH by file count, LOW per PR. Incremental merges keep blast radius small.

**Size**: 5–7 days (includes migrating `app.css` shared patterns into shared components with Tailwind — this is the hidden scope Codex #7 called out). Parallelisable (Step1, Step2, Step3 are independent once shared primitives land).

---

### Phase 5 — Route tree overhaul (per-step routes + dedicated render route + layout slots + loader)

**Goal**: URL becomes the source of truth for "what screen am I on". Fixes two real UX bugs (refresh mid-wizard drops state context; refresh mid-render forces back to Step 3) AND reserves the extensibility slots (AuthLayout, `/tasks`, `/login` URL shapes). Dissolves the current dispatch-vs-attach code split (both paths → `/render/:taskId`).

**Prereqs**: Phase 1 (api.result), Phase 2 (wizard store for wizard step validation), Phase 4 (components small enough to plug into routes cleanly).

**Tasks**:
1. Swap to `createBrowserRouter` in `App.jsx`. Route tree as documented in §2.
2. `layouts/AppLayout.jsx` — absorbs the current `HostStudio` shell: TopBar + `<Outlet />`. Handles header/queue visibility.
3. `layouts/AuthLayout.jsx` (E1) — minimal shell (no TopBar), empty route body today. Reserved for `/login`, `/signup`, `/reset-password`.
4. `routes/IndexRoute.jsx` + `indexLoader` — "/" smart redirect:
   - If `queueStore` has a `running` task → redirect to `/render/:taskId` of the first one.
   - Else if URL history shows a recent `/result/:taskId` → redirect there (optional nicety).
   - Else → `/step/1`.
5. `routes/WizardStep.jsx` + `stepLoader`:
   - Reads `n` param (must be `"1" | "2" | "3"`).
   - Guard: if `n > 1` and previous step's required data is missing (from `wizardStore` selector), redirect to the first incomplete step. Selectors `isStep1Complete`, `isStep2Complete` live in `wizardStore`.
   - Renders `Step1Host`, `Step2Composite`, or `Step3Audio` from `studio/step{1,2,3}/`.
6. `routes/RenderPage.jsx` — `taskId` from `useParams()`, passes to `<RenderDashboard taskId={taskId} />`. On stage-complete, the dashboard calls `navigate('/result/' + taskId, { replace: true })`.
7. `routes/ResultPage.jsx` with `resultLoader`:
   - Loader: `({ params, request }) => api.result.fetchResult(params.taskId, { signal: request.signal })`.
   - `errorElement: <ResultNotFound />` — handles 404 (no manifest + not in queue).
   - `ResultPage` reads via `useLoaderData()`; no fetch/loading useEffect inside.
8. `routes/TasksComingSoon.jsx` (E5, E6) — placeholder at `/tasks`. Renders "준비 중" state so the queue panel's "모두 보기 →" link has somewhere to go and the URL shape is reserved.
9. `routes/NotFound.jsx` — catch-all for unknown paths.
10. **Queue click handlers** simplify: `navigate('/render/' + taskId)` for running/pending, `navigate('/result/' + taskId)` for completed. Delete the `?attach=` URL param scraping in `HostStudio` (which is dying anyway).
11. **"영상 만들기" button** in Step3 dispatches then navigates: `const { task_id } = await api.composite.generate(...); navigate('/render/' + task_id);`.
12. Step pills (1/2/3 indicator in TopBar) use `Link` to `/step/:n` — browser back/forward now works across wizard steps.

**Files touched**:
- Modified: `App.jsx` (full route tree), queue click handlers, Step3 submit handler.
- New: `layouts/{App,Auth}Layout.jsx`, `routes/{IndexRoute,WizardStep,RenderPage,ResultPage,TasksComingSoon,NotFound}.jsx`, `ResultNotFound.tsx`.
- Modified: `ResultPage` body (drop own fetch), `RenderDashboard` (drop attach branch, read taskId from props).
- Deleted: `HostStudio.jsx` (split into `AppLayout` + `WizardStep`).

**Validation**:
- Existing tests migrate to `createMemoryRouter`.
- New `routes_guards.test.jsx`: direct `/step/3` nav with no Step 1 data → redirects to `/step/1`.
- Manual smoke: refresh on Step 2 stays on Step 2; refresh mid-render stays on render page; click running task in queue → `/render/:id`; complete → auto-nav to `/result/:id`; back button returns to `/render/:id` → no, `replace: true` prevents this (intentional).

**Rollback**: router v7 supports mixing loader and element-only routes; can revert per-route if one path regresses.

**Risk**: MEDIUM. Route refactor touches every navigation surface. Mitigation: each route component ships in its own sub-PR; route table swap is the last PR.

**Size**: 1.5 days (was 0.5 — the expansion is almost entirely offset by simplification elsewhere: `rendering`/`attachToTaskId` state deleted, `?attach=` scraper deleted, dispatch/attach branch deleted).

---

### Phase 6 — Testing Gaps

**Goal**: Catch the regressions the current test suite misses.

**Prereqs**: none strict — can run alongside every phase.

**Tasks**:
1. **Playwright**: one happy path (Step 1 → Step 2 → Step 3 → render → result) and one cancel path (enqueue, cancel from QueueStatus). Runs against `vite preview` + a mock backend or fixture server.
2. **Hook unit tests** for each hook added in Phase 3 — mock `api.*`, assert `abort()` called on unmount, assert state transitions (`loading → success`, `loading → abort → idle`).
3. **Store unit tests**: queueStore poll start/stop reference-counts correctly; wizardStore `persist` round-trip without transient fields.
4. **SSE cancellation test**: mock `ReadableStream`, start `streamHostCandidates`, abort mid-stream, assert no more `onEvent` calls.

**Files touched**: new `tests/` tree (Playwright) or `src/**/__tests__/`.

**Validation**: CI runs unit + Playwright; green on main before Phase is closed.

**Rollback**: tests are additive — never blocks anything.

**Playwright harness reality check** (Codex #9):
A real wizard E2E needs a deterministic backend — uploads, streaming generation, queue polling, completion, manifests. Options:
- **Fixture-mode backend** — `FLASHTALK_FIXTURE=1` env var makes `app.py` skip Gemini/FlashTalk and return pre-recorded responses + seeded result MP4s. Smaller blast radius; runs in CI.
- **Full mock server** — MSW or a tiny Flask shim replaces `app.py` entirely. Faster CI, but the shim drifts from real API.

Picking fixture-mode for now (keep one system, make it toggleable). Alone this is ~1 day of backend plumbing.

**Risk**: LOW (tests are additive).

**Size**: 3–4 days (was 1.5 — the Playwright harness + fixture backend is the real work; Codex #9 was right).

---

## 5. Dependency Order (one-glance)

| # | Phase | Blocks | Blocked by | Can run with |
|---|---|---|---|---|
| 0 | Toolchain + BE response_models | 1, 2 | — | — |
| 1 | API layer + auth-header provider (E2) | 2, 3 | 0 | 6 (partially) |
| 2 | Stores + storageKey factory (E3) + migration | 3, 4 | 0, 1 | — |
| 3 | Hooks | 4 | 1, 2 | 6 |
| 4 | Decompose + Tailwind + TaskRow (E4) | 5 | 3 | 6 |
| 5 | Route tree (per-step + /render/:id + loader + layouts E1 + /tasks placeholder E5 + reserved URLs E6) | — | 1, 2, 4 | any after 4 |
| 6 | Testing | — | — | any phase |

**Total estimate (post extensibility/routing adjustments)**: **14–19 days** of focused work for a single dev.
- Phase 0: 1 day (toolchain + backend response_models)
- Phase 1: 1.5 days (+ auth-header provider hook = E2, noop today)
- Phase 2: 2 days (+ storageKey factory = E3)
- Phase 3: 1.5 days
- Phase 4: 5–7 days (component decomposition + app.css → shared components + TaskRow extraction = E4)
- Phase 5: **1.5 days** (was 0.5 — full route tree overhaul per Decision #10 + layouts E1 + TasksComingSoon placeholder E5 + reserved URLs E6). Note this was the delta from the previous 13–18 day estimate.
- Phase 6 (Testing): 3–4 days (Playwright + fixture backend)

Parallelisable once Phase 3 is done (Steps 1/2/3 independent). Route tree swap (Phase 5 final PR) should land after Phase 4 stabilises.

---

## 6. Decisions Log (what was considered, what was picked)

| Choice | Picked | Rejected | Reason |
|---|---|---|---|
| State mgmt | Zustand | Context+useReducer, Jotai, Redux Toolkit | Selector-based subs fix re-render storms; `persist` middleware kills the hand-rolled localStorage code; no provider trees. |
| Queue poll | `useSyncExternalStore` in Zustand | `useEffect` in a provider | External store is tear-free, works outside React, auto-cleanup on last subscriber. |
| Styles | Tailwind v4 + keep `app.css` BEM | CSS Modules, vanilla-extract, Panda, UnoCSS | v4's `@theme` bridges existing CSS custom properties → zero visual diff Day 1. Hand-written BEM classes aren't worth rewriting; utilities replace inline styles only. |
| Types | TypeScript w/ `allowJs: true` | PropTypes, JSDoc only | Incremental rename `.jsx → .tsx` as each component is touched in Phase 4. No big-bang rewrite. |
| Router data | Loaders at `/`, `/step/:n`, `/result/:taskId` — narrow & gating; step bodies stay imperative | Loaders everywhere (full v7 data-routing) or nowhere | Loaders collapse fetch+loading+404 cascades on frozen reads and encode route guards declaratively (`/step/3` with no Step 1 data redirects at loader time). Step bodies stay imperative because multi-stage SSE pipelines don't map to `loader`/`action` semantics. |
| React 19 `use()` | Skip for SSE | Adopt for subscriptions | `use()` is for one-shot promises/context; SSE is a long-lived subscription. Wrong tool. |
| Form hooks (`useActionState`, etc.) | Skip | Adopt for wizard steps | This isn't form submission — multi-stage pipelines with SSE don't map to `<form action={fn}>` semantics. |
| E2E | Playwright | Cypress, none | Modern default; runs headless in CI; good network mocking. |

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Phase 2 (stores) touches RenderDashboard AND HostStudio simultaneously. | Ship queueStore first (isolated), wizardStore second in a separate PR. |
| Tailwind `@theme` bridge might miss a token and cause drift. | Day-1 check: run the app, take a screenshot, compare to a baseline. Every token in `tokens.css` must have a `@theme` line. |
| Zustand `persist` migration loses user's in-progress wizard state. | Add a one-time migration hook: on first load under the new version, read the old `localStorage.showhost_state`, transform into the Zustand shape, write, delete old key. |
| SSE stream abort behaviour varies by browser. | Test on Chromium + Firefox; fall back to checking `controller.signal.aborted` before each reader read. |
| Phase 4 decomposition introduces visual regressions. | Playwright screenshot snapshots per route before/after; manual review on every PR. |
| Zustand bundle cost. | ~1.2KB gzipped — acceptable. |
| Type drift between backend and frontend types. | `npm run gen:types` regenerates from `/openapi.json` during Phase 0; CI runs it and fails if the committed `src/types/generated/api.d.ts` drifts from backend reality (any schema change forces a type update in the same PR). |
| Old bookmarks/links to `/?attach=xxx` break after route migration. | `HostStudio`'s `?attach=` handler stays through Phase 4; Phase 5 replaces it with a redirect shim (`/` with `?attach=xxx` → `navigate('/render/' + xxx, {replace:true})`) so external bookmarks keep working. |
| Users with an in-flight render on an old URL when Phase 5 lands. | Persisted queue + `useQueueEntry` mean the render keeps running server-side; the user's first nav to `/` after the upgrade hits the index-redirect loader and lands on `/render/:taskId` automatically. |

---

## 8. Out of Scope (NOT doing this refactor)

- **Broad backend refactor** — only the narrow response_model slice listed in Phase 0 is in scope. No endpoint behavior changes, no new features, no schema changes beyond declaring what's already returned.
- **Authentication / multi-user system** — the refactor leaves **slots** (E1 `AuthLayout`, E2 auth-header provider, E3 storage-key factory, E6 reserved URLs) but does NOT implement any of it. Login/signup/session/user-scoped-data is a **separate project** that spans frontend AND backend (user table, session middleware, `user_id` columns on tasks/uploads/outputs, access control on `outputs/` and `uploads/` directories, rate limiting per user). Don't let this plan silently promise that.
- **Full `/tasks` page** — E5 adds a placeholder route that renders "준비 중". The actual page (filter/search/sort/pagination/detail view) ships later.
- **Projects / workspaces / team sharing** — not designed-for beyond what basic auth enables. When the team collaboration story is real, it's its own design cycle.
- **Internationalisation** — Korean copy stays hard-coded. i18n is its own project.
- **Dark mode re-theming** — tokens exist but not actively exercised. Out.
- **Cross-tab state sync** (Zustand `persist` across multiple tabs via `storage` events) — explicit non-goal; current behavior is also single-tab.
- **Replacing the SSE dev-proxy tuning in `vite.config.js`** — recent fix, working; leave alone.
- **Backend OpenAPI-to-Pydantic across all endpoints** — only the frontend-consumed ones get response models. Admin/internal endpoints stay untyped.
- **State machine library** (xstate) for the wizard — Zustand + hooks is enough for a 3-step wizard. Revisit at 6+ steps.
- **Visual design refresh** (new components, new tokens, dark mode) — purely a structural refactor; pixels don't change.
- **Notification system** (real-time push on task completion) — out. Queue polling is good enough for now; if we later add push, it plugs into `queueStore` without schema change.

---

## 9. What already exists (reused, not rebuilt)

- `QueueContext.jsx` (20-line poller) — logic preserved; container becomes a Zustand store.
- `api.js` (620 LOC, 35+ functions) — code is correct; only org and AbortSignal plumbing change.
- `humanizeError` — moves to `api/http.ts`, no rewrite.
- `primitives.jsx` (`Badge`, `Button`, etc.) — gets extended with the new shared visual components (`Card`, `StepPill`, `VoiceRow`, `AudioPlayer`, `Confetti`), not replaced.
- `AudioPlayer` inline in `Step3Audio.jsx` — extracted, not rewritten.
- `ProvenanceCard.jsx` — already extracted, shared between `/` and `/result/:taskId`.
- `taskFormat.js` — already the canonical helper for task titles across surfaces (renamed to `.ts` in Phase 4).
- `Confetti` (duplicated in `RenderDashboard` + `ResultPage`) — dedup into `shared/Confetti.jsx`, no behavior change.
- 105 passing vitest cases — migrated, not thrown away.
- `EventSource` proxy tuning in `vite.config.js` — unchanged.
- Backend endpoints — behavior unchanged. Only added: Pydantic response_model declarations that describe what's ALREADY being returned.

## 10. Failure Modes (per new codepath, from Test Review)

| # | Codepath | Realistic failure | Test? | Handled? | Visibility |
|---|---|---|---|---|---|
| 1 | Zustand `persist` first-load migration | Legacy payload shape changes (new `imageQuality` field missing) → Zustand crashes hydrating | **mandatory test** | yes — fallback to INITIAL_STATE + log | user sees wizard reset (acceptable) |
| 2 | `useHostGeneration` stale-result rejection | User "다시 만들기" twice; first stream's result lands after second's start | unit test (epoch) | yes | silent drop (by design) |
| 3 | `useRenderJob` polling during backend restart | `/api/tasks/:id/state` 404 while backend boots → we currently give up after 8 errors | unit test | yes — shows error state | user sees "연결 끊김" badge |
| 4 | `openapi-typescript` drift | Backend adds field to response; types file committed on main is stale → merge breaks | CI check (`gen:types` + `git diff --exit-code`) | yes — PR fails to merge | PR reviewer sees it |
| 5 | Router loader on `/result/:taskId` with missing taskId | User types in URL garbage → loader throws | `result_page.test.jsx` — 404 path | yes — `errorElement` shows "결과를 찾을 수 없어요" | user sees friendly 404 |
| 6 | Tailwind `@theme` token miss | New token added to `tokens.css`, forgotten in `@theme` block → visual drift | screenshot snapshot test (Playwright) | partial — CI catches it only if the drift is visible | visible regression |
| 7 | Component decomposition re-render cost | Selector fires for every store update → wizard steps re-render on queue poll | profiled during Phase 4 | yes — selectors are per-slice | perf test in Playwright happy path |
| 8 | Direct `/step/3` URL with no Step 1 data (bookmark/link/paste) | Step 3 tries to render with `host.selectedUrl === undefined` → crash or garbage UI | `routes_guards.test.jsx` — assert redirect to `/step/1` | yes — step loader redirects at route entry | user lands on `/step/1`, no flash of broken Step 3 |
| 9 | Legacy `/?attach=xxx` bookmark after Phase 5 | Old link breaks → user sees empty wizard shell or 404 | `legacy_attach_redirect.test.jsx` — seed URL, assert `navigate('/render/xxx', {replace:true})` fires | yes — Phase 5 adds a one-shot redirect shim | silent, feels like no break |
| 10 | `/render/:taskId` with garbage taskId (typo in URL) | Queue store has no entry; progress poll 404s; user stuck on spinner | `render_page.test.jsx` — assert error state + "되돌아가기" button appears after N seconds of no data | yes — RenderPage shows "작업을 찾을 수 없어요" after 3 empty queue polls | user sees friendly not-found + button back to `/step/3` |

**Critical gaps** (no test AND no handling AND silent):
- None after this plan lands. Migration test (#1) closes the one current critical gap; step guards (#8) and legacy attach (#9) close the ones the routing change introduces.

## 11. Parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| Phase 0 (FE toolchain) | `tsconfig`, `eslint`, `prettier`, `tailwind`, `src/types/` | — |
| Phase 0 (BE response_models) | `app.py` (narrow) | — |
| Phase 1 | `src/api/` (new), `src/studio/{ResultPage,RenderDashboard}.jsx` (1 line each), tests | Phase 0 |
| Phase 2a (queueStore) | `src/stores/queueStore.ts`, `QueueStatus.jsx`, `RenderHistory.jsx`, `RenderDashboard.jsx` (reads) | Phase 0, 1 |
| Phase 2b (wizardStore + migration) | `src/stores/wizardStore.ts`, `HostStudio.jsx`, `ErrorBoundary.jsx`, tests | Phase 0, 1 |
| Phase 3 (hooks) | `src/hooks/` (new) | Phase 1, 2 |
| Phase 4a (Step1 decompose) | `src/studio/step1/*`, `primitives.jsx` (extend) | Phase 3 |
| Phase 4b (Step2 decompose) | `src/studio/step2/*` | Phase 3 |
| Phase 4c (Step3 decompose) | `src/studio/step3/*` | Phase 3 |
| Phase 4d (render/result/queue decompose) | `src/studio/{render,result,queue}/*` | Phase 3 |
| Phase 5 (route tree overhaul) | `App.jsx`, `layouts/{App,Auth}Layout.jsx`, `routes/{IndexRoute,WizardStep,RenderPage,ResultPage,TasksComingSoon,NotFound,ResultNotFound}.jsx`, Step3 submit handler, queue click handlers, deletion of `HostStudio.jsx` | Phase 1, 2, 4 |
| Phase 6 (testing) | `playwright.config.ts`, fixture backend (`FLASHTALK_FIXTURE=1`), E2E tests, hook unit tests, store unit tests | any phase |

**Parallel lanes**:
- Lane A: `0 (FE) → 1 → 2a → 2b → 3 → {4a, 4b, 4c, 4d in parallel} → 5`
- Lane B: `0 (BE response_models)` — merges before Phase 1 starts consuming generated types.
- Lane C: `Phase 6 (Playwright harness + fixture backend)` — runs in parallel with any phase once Phase 1 is merged; test coverage fills in as surfaces stabilise.

**Conflict flags**:
- **Phase 2a and 2b both write to `App.jsx`** (one removes `<QueueProvider>`, the other wires wizardStore provider-less). Sequentialise: 2a first, 2b second.
- **Phase 4a/b/c all import `primitives.jsx`**. First landing PR adds the shared components; subsequent PRs import. Coordinate who owns the primitive extraction (likely the first of Step1/Step2/Step3 to land).
- **Phase 5 deletes `HostStudio.jsx`** — any in-flight PR that touches HostStudio must rebase or land BEFORE Phase 5 opens.
- **Phase 0 (BE) and any ongoing backend work** — coordinate via the narrow-slice list. response_model decorators are additive and low-risk.

**Execution order recommendation**: `0 (both FE+BE) → 1 → 2a → 2b → 3 → 4 (parallel sub-PRs) → 5`, with `6` opportunistically in parallel with `3` onward.

## 12. First Commit After Plan Approval

`Phase 0a — Frontend toolchain (tsconfig + eslint + prettier + tailwind v4 + openapi-typescript + type codegen script)` — should land in one PR, be completely invisible to users, and turn the code green under `npm run check`.

Right after, in a separate PR: `Phase 0b — Backend response_models for frontend-consumed endpoints` — additive Pydantic type declarations on `/api/queue`, `/api/results/:id`, `/api/tasks/:id/state`, `/api/history`, `/api/hosts/candidates`.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (purely structural refactor, no product scope) |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 10 findings; 5 integrated into plan, 3 resolved via user decision, 2 noted as non-goals |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 3 arch issues (all resolved), 1 test gap (resolved), outside voice run |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a — no UI changes, only structural |
| DX Review | `/plan-devex-review` | DevEx gaps | 0 | — | n/a — not a dev-facing product |

- **CODEX:** 10 findings: 5 plan gaps filled (variants persistence reference, render-mode state, concurrency epoch, global CSS import, ErrorBoundary migration); 3 user-decided (wizardStore kept, queueStore kept, backend response_models added to scope); 2 accepted as estimate corrections (Tailwind scope → 5–7 days; E2E → 3–4 days).
- **CROSS-MODEL:** On "is Zustand overkill for wizardStore/queueStore" Claude and Codex disagreed. User adjudicated: keep Zustand for both (consistency + selector ergonomics > minimum-diff). Codex #4 concern (`rendering`/`attachToTaskId` missing from store) auto-resolved when Decision #10 moved those concepts into the URL.
- **UX ROUND (post-eng-review):** Two additional user-surfaced UX issues — (a) refresh mid-wizard doesn't preserve step in URL; (b) refresh mid-render dumps user back to Step 3. Resolved together with per-step routing + `/render/:taskId` route (Decision #10, Phase 5 expanded).
- **EXTENSIBILITY ROUND:** Six slots (E1–E6) added to design for login/multi-user/full Tasks page without building them this refactor. Backend-side auth work explicitly scoped OUT (separate project).
- **UNRESOLVED:** 0.
- **VERDICT:** ENG CLEARED — ready to implement, starting with Phase 0a (frontend toolchain) + Phase 0b (backend response_models) in parallel PRs.
