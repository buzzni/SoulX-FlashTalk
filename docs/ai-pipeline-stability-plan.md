# AI Generation Pipeline Stability Plan

**Status**: Reviewed via `/plan-eng-review` 2026-04-27 — all 14 decisions locked, ready to implement
**Author**: Claude (with Codex audit + Explore-agent map of frontend, 2026-04-27)
**Companion to**: `docs/frontend-refactor-plan.md` (Phases 0–2 done, 3–7 pending)
**Branch target**: `feat/pipeline-stability` off `main` (currently `67a2841`)

---

## 1. Why this exists

Phase 1–2 of the wizard refactor moved every slice onto **compile-time** tagged unions. That stops "impossible state" combinations from being typeable, but the pipeline still fails at **runtime boundaries** — places where data crosses from outside the type system back into it:

| Boundary | What's in place today | Failure mode |
|---|---|---|
| `localStorage` hydrate | `migrateLegacyToSchema(...) as WizardState` | Bad legacy shape silently produces a half-valid state; first runtime read crashes deep in a step |
| API responses (host SSE, composite SSE, voice generate, upload, progress) | `await fetchJSON<T>()` — generic only, no runtime check | Backend renames `seed` → `seedValue`; SSE iterator yields `undefined`; UI shows blank variant; no error |
| File uploads | `UploadResult { path?, url?, [key: string]: unknown }` permissive | `path` undefined → render dispatch posts `null` → 500 from backend with no client-side context |
| Form submission | inline `prompt.length >= 15`, scattered ternaries | Invalid combinations not blocked at submit; user gets backend 400 toasts |
| Browser back during render | wizard store still says `voice.generation.state = 'ready'` | Re-clicking "음성 생성" launches a duplicate TTS job |
| Long-running generation | manual `setTimeout` polling with fixed 1500ms, no backoff, no dedup | Network hiccup → 8 errors → give up; user re-clicks → backend has 2 jobs |
| Progress polling | string-signature change detection (`stage|progress|message`) | New `output_path` field arrives without signature change, UI never updates |

The codebase already paid the cost of compile-time types. We now want runtime validation, structured async state, and unified form ergonomics so every boundary is **parsed**, not **trusted**, and so the UI can model `idle / loading / success / error / retrying` without per-hook ad-hoc state machines.

## 2. Library decisions

### 2.1 Adopting

| Library | Version pin | Bundle (gzip) | Why |
|---|---|---|---|
| `zod` | `^3.23` | ~14 KB | Runtime validation at every untrusted boundary. Discriminated unions match our tagged-union schema layer 1:1. |
| `react-hook-form` | `^7.54` | ~9 KB | Per-step form state with native validation, dirty/touched, error wiring, refs (no controlled re-render storm). |
| `@hookform/resolvers` | `^3.9` | ~1 KB | Bridges zod → RHF. We pull only the `zod` subpath. |
| `@tanstack/react-query` | `^5.59` | ~13 KB | Mutations for one-shot calls (upload, generate, dispatch render). Queries with built-in retry/backoff/dedup for progress polling. |
| `@tanstack/react-query-devtools` | `^5.59` | dev-only (`-D`) | Inspect query/mutation cache during stabilization work. |
| `react-error-boundary` | `^4.1` | ~1 KB | Declarative error boundaries with reset semantics; replaces `studio/ErrorBoundary.jsx`. |
| `openapi-zod-client` (or equivalent) | dev-only (`-D`) | dev tool | Generate zod schemas from backend OpenAPI alongside existing `openapi-typescript`. |
| `size-limit` (or `@size-limit/preset-app`) | dev-only (`-D`) | dev tool | Bundle-size CI gate enforcing the <50KB gzip Done criterion. |

Total runtime added: **≈38 KB gzipped**. Acceptable; existing wizard chunk is much larger and we lazy-route per step page.

### 2.2 Considered and rejected

| Library | Why not |
|---|---|
| `axios` | `api/http.ts` already does what we need; migrating breaks abort plumbing. |
| `swr` | Weaker mutation story and no native retry/backoff. |
| `formik` / `final-form` | RHF wins on uncontrolled-by-default architecture and zod integration. |
| `yup` / `valibot` / `arktype` | zod is the de-facto choice for RHF + TS; valibot leaner but RHF resolver maturity weaker. |
| `tiny-invariant` / `ts-pattern` | Nice-to-have, not stability-critical. |
| `immer` | Explicit spread + tagged-union builders work fine; immer hides union narrowing. |

### 2.3 Already in stack — keep

`zustand`, `react-router-dom` v7, `lucide-react`, `tailwindcss` v4 + shadcn, `vitest` + `@testing-library/react`, `Playwright`, `openapi-typescript` v7. No replacements.

## 3. Target architecture

```
                    ┌──────────────────────────────────────┐
                    │  Schema sources                      │
                    │  • backend OpenAPI → gen:types       │
                    │                  → gen:zod (NEW)     │
                    │  • src/wizard/schema.ts (UI domain)  │
                    │  • src/api/sse-schemas.ts (hand, SSE)│
                    └─────────────────┬────────────────────┘
                                      │ z.infer<>
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
              ▼                       ▼                       ▼
   ┌─────────────────────┐ ┌────────────────────┐ ┌──────────────────────┐
   │  Wizard store       │ │  RHF forms         │ │  API client + TQ     │
   │  (zustand + persist)│ │  (per step page)   │ │  (mutations/queries) │
   │  hydrate: zod parse │ │  resolver: zodRes. │ │  fetchJSON(...,      │
   │  scrub: streaming/  │ │  watch→draft (debc)│ │    { schema: X })    │
   │   failed/generating │ │  submit→final+mut. │ │  parses on response  │
   └─────────┬───────────┘ │  useFormZustandSync│ └──────────┬───────────┘
             │             └─────────┬──────────┘            │
             │                       │                       │
             └───────────────────────┴───────────────────────┘
                                     │
                                     ▼
                       ┌─────────────────────────┐
                       │  React tree             │
                       │  • <ErrorBoundary>      │
                       │  • <QueryClientProvider>│
                       │  • <FormProvider> per   │
                       │    step                 │
                       └─────────────────────────┘
```

### 3.1 Schema layer (D6, D7, D11, D12, D13)

**Rule**: zod schema is the source. TS types are `z.infer<typeof Schema>`. Hand-written schemas only where generation can't reach (UI domain, SSE).

**Schema sources** (D13):

1. **`src/types/generated/api.d.ts`** — already exists, OpenAPI → TS via `npm run gen:types`.
2. **`src/api/schemas-generated.ts`** (NEW) — OpenAPI → zod via `npm run gen:zod` (one-time tool pick: `openapi-zod-client` is the leading candidate; pin during Lane A). Schemas for `UploadResult`, `TaskStateSnapshot`, `TaskResult`, `VoiceGenerateResponse`, `HistoryItem`, `PresetItem`, `PlaylistItem`, etc. Backend rename → one regen, both layers update.
3. **`src/api/sse-schemas.ts`** (NEW, hand-written) — only SSE events (OpenAPI doesn't model streams well). Schemas mirror **wire shape** (snake_case) and use `.transform()` to derive client shape. Example:
   ```ts
   export const HostStreamCandidateSchema = z.object({
     type: z.literal('candidate'),
     seed: z.number(),
     batch_id: z.string(),
     path: z.string(),
     url: z.string(),
   }).transform(raw => ({
     type: 'candidate' as const,
     seed: raw.seed,
     batchId: raw.batch_id,
     path: raw.path,
     url: raw.url,
     imageId: imageIdFromPath(raw.path),
   }));
   ```
4. **`src/wizard/schema.ts`** — UI-only domain (existing). `*Schema` zod constants for `Background`, `Host*`, `Product*`, `CompositionSettings`, `Voice*`, `Resolution*`. `type X = z.infer<typeof XSchema>` aliases preserve all imports. Branded types stay (`AssetId`, `BatchId` via `.brand<>()`).

**`fetchJSON` signature change** (D7): bake the parse in.
```ts
// http.ts (Lane B)
export async function fetchJSON<S extends z.ZodTypeAny>(
  path: string,
  opts: FetchJSONOptions & { schema: S },
): Promise<z.infer<S>> { /* parse internally */ }
```
Schema is a required option at the call site — structurally enforced; impossible to forget.

**Wizard state schemas — runtime vs persisted** (D11):

```ts
// LocalAsset includes File + blob URL — runtime only
export const LocalAssetSchema = z.object({ kind: z.literal('local'), file: z.instanceof(File), previewUrl: z.string() });
export const ServerAssetSchema = z.object({ kind: z.literal('server'), path: z.string(), url: z.string() });

// Runtime state — what live React sees, includes File handles
export const WizardStateSchema = z.object({ /* ... */ });

// Persisted state — what localStorage holds, no File handles
export const WizardStateSerializedSchema = WizardStateSchema.deepReplace(LocalAsset → null);
// (or equivalent: persistable variants of every slice)
```

Persist envelope: `WizardEnvelopeSchema = z.object({ state: WizardStateSerializedSchema, version: z.number() })`. Hydrate path uses `WizardStateSerializedSchema.safeParse`; runtime never serializes File handles by accident.

**Form schemas use domain schemas directly** (D6): no separate `HostFormSchema`. RHF resolver = `zodResolver(HostInputSchema)`. Submit-time-only refinements (e.g. `prompt.length >= 15`) live inline as `.refine()` in the resolver call:
```tsx
const form = useForm({ resolver: zodResolver(HostInputSchema.refine(...)) });
```

### 3.2 Form layer (D2, D6, D14)

**One RHF instance per step page**.

**Sync rule** (D2 — debounced live sync):
- **`watch` → zustand draft** with 300ms debounce. Preserves current "every change persists" UX.
- **`onSubmit` → zustand final + fires mutation**. Submit writes the validated payload, not the in-flight draft.
- **`useFormZustandSync(form, slice)` helper** (D14 #2): bridges store → form direction. Subscribes to slice updates, calls `form.reset(...)` when external updates land (generation result, variant pick, upload completion). Without this RHF defaults go stale on background updates.
- **Auto-save indicator** (D4 cherry-pick): each debounced write also stamps `lastSavedAt: Date.now()` on the wizard store; `<AutoSaveIndicator />` (in wizard footer) reads it and renders "방금 전 저장됨" / "5초 전 저장됨" / "1분 전 저장됨" — surfacing the invisible auto-save mechanism so users feel the safety, not just benefit from it.

```tsx
// src/wizard/steps/step1-host/Step1Host.tsx (post-Phase 3 selectors)
const host = useHost();
const setHost = useWizardActions().setHost;
const form = useForm({
  resolver: zodResolver(HostInputSchema),
  defaultValues: hostSliceToFormValues(host),
  mode: 'onBlur',
});
useFormZustandSync(form, host, hostSliceToFormValues);  // store → form
useDebouncedFormSync(form, setHost, formValuesToHostSlice, 300);  // form → store draft
const onSubmit = form.handleSubmit((values) => {
  setHost(formValuesToHostSlice(values, host));
  generate.mutate(toHostGenerateRequest(values));  // see §3.3
});
```

**Conventions**:
- The slice in zustand stays the source of truth for *transient* fields (generation state, streaming variants). RHF only owns *user-input* fields (prompt, builder chips, ref asset, advanced sliders).
- `mode: 'onBlur'` for text, `mode: 'onChange'` for tabs/radios.
- Tagged unions (e.g. `Background.kind`) → use zod `discriminatedUnion`, render Tabs that control a hidden `kind` field; conditional sub-forms via `useWatch({ name: 'kind' })`. **No `as any`**.
- Validation messages: zod `.message('...')` per rule, in Korean. Render under input via `<FieldError name="..." />` thin wrapper.
- Submit button disabled state: `formState.isValid && !mutation.isPending`.

**Wrapper component**: `<WizardField name=...>` (NEW, in `src/components/wizard-field.tsx`) wires `register` + zod error rendering automatically.

### 3.3 Async layer — TanStack Query (D5, D12, D14)

**Setup**: `<QueryClientProvider>` mounted in `src/main.jsx` (note: `.jsx`, not `.tsx` — see C14 errata). `QueryClient` config:

```ts
const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, err) =>
        failureCount < 3 && err instanceof ApiError && err.status >= 500,
      retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: 0 },  // safe default; per-mutation override below
  },
});
```

**Mutation retry policy** (D5): default `retry: 0`. Idempotent mutations opt in:
- `useUploadImage`: `retry: 1, retryDelay: 1000` — uploads are idempotent at backend (each call creates a fresh asset).
- `useHostGenerate`, `useGenerateVoice`, `useDispatchRender`: `retry: 0` — generation POSTs must NOT auto-retry (would create duplicate jobs).

**Mutations**:
- `useUploadImage(kind)` — wraps existing `uploadHostImage` / `uploadReferenceImage` / `uploadBackgroundImage`. Uses zod-parsed `UploadResult`. Surfaces error/retry. **Upload progress is NOT shipped in this plan** (browser `fetch` doesn't expose it; XHR migration deferred — see §8 Deferred).
- `useHostGenerate()` — non-streaming variant (kept for compatibility; not the Step 1 main path).
- `useDispatchRender()` — POST `/api/generate`.
- `useGenerateVoice()` — TTS or clone trigger.

**Queries**:
- `useTaskProgress(taskId)` — replaces `subscribeProgress`. **D5 cherry-pick**: also writes `document.title = "${progress}% — 영상 생성 중"` while polling, restores prior title on unmount via `useEffect` cleanup. Lets multi-tab users glance at the tab bar to check render progress. **TQ v5 `refetchInterval` callback receives the query object**, not raw data:
  ```ts
  refetchInterval: (query) => {
    const stage = query.state.data?.stage;
    return stage === 'complete' || stage === 'error' ? false : 1500;
  }
  ```
- `useTaskResult(taskId)`, `useHistoryFeed()`, `usePresets()`, `usePlaylists()` — straightforward queries.

**SSE adapter** (D1, D12): mutation drives writes; cache key is a **client-generated request UUID** (D12 #2 — `HostGenerateInput` has no `batchId` until init lands).

```ts
// src/api/queries/use-host-stream.ts
export function useHostStream() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ input, requestId }: { input: HostGenerateInput; requestId: string }) => {
      const events: HostStreamEvent[] = [];
      for await (const wireEvt of streamHost(input)) {
        const evt = HostStreamEventSchema.parse(wireEvt);  // wire → client via .transform()
        events.push(evt);
        qc.setQueryData(['host-stream', requestId], [...events]);
        if (evt.type === 'fatal') throw new Error(evt.error);
      }
      return events;
    },
  });
}
// Caller:
const requestId = useMemo(() => crypto.randomUUID(), [/* per dispatch */]);
const stream = useHostStream();
// Subscriber elsewhere reads via:
const { data: events } = useQuery({ queryKey: ['host-stream', requestId], enabled: false });
```

**Cancellation reality** (D14 #1): TQ exposes `signal` on **queries**, not mutations. `useAbortableRequest` survives in **SSE consumers** (Step 1 host generation, Step 2 composite generation) where late results from canceled streams must be ignored. Lane H deletion is downgraded to "remove from upload + polling consumers only."

**Lane E first**: Lane E (polling + upload via TQ) ships before Lane F (SSE bridge). If TQ doesn't feel right by Lane E acceptance, the SSE bridge gets reconsidered before Lane F.

### 3.4 Persistence layer (D11)

`zustand/persist` stays. Three changes:

1. **Lane B.5 reconciliation** — fix existing `WizardState` shape drift between `wizardStore.ts:51–67` and `wizard/schema.ts:301` BEFORE Lane C runs `safeParse`. Decide: store grows `playlistId`/`script: Script` to match schema, OR schema absorbs flat shape. Without this Lane C resets every existing user blob.
2. **`migrate` validates with zod** — after `migrateLegacyToSchema` runs, call `WizardStateSerializedSchema.safeParse(p)`. On failure, log + return `INITIAL_WIZARD_STATE`. Drop `wizardStore.ts:319` `as WizardState`.
3. **`onRehydrateStorage` transient scrub** — scrub `'streaming' | 'failed'` (or `'generating' | 'failed'` for voice) → `'idle'`. **Preserve `'ready'`** because selected variants and generated assets are reloadable server paths; current `normalizers.ts:95/125/147` already scrub correctly. Adding `'ready'` to the scrub list deletes completed-generation progress on refresh — a hard UX regression.

### 3.5 Error layer (D4)

Three boundaries:

1. **Top-level** (`<App>` outer, Lane A) — catches render-time crashes. "다시 시도" page.
2. **Per step page** (Lane G) — `<ErrorBoundary FallbackComponent={StepErrorFallback}>` around each `<Step1Host>`, `<Step2Composite>`, `<Step3Audio>`, `<RenderPage>`. Reset key = `step + wizard slice version`.
3. **Mutation/query error UI** (Lane G):
   - Mutation error → contextual `<ErrorAlert onRetry={mutation.reset}>` next to the action. Toast still fires for ambient errors.
   - Upload errors → re-upload prompt: keep `File` reference in form state; `<RetryUploadButton onClick={() => upload.mutate(file)}>`.
   - Voice clone job mid-stream failure → reset `voice.sample.state` to `'idle'` automatically.

**Legacy ErrorBoundary** (D4): `studio/ErrorBoundary.jsx` is **deleted** in Lane G — its replacement is `react-error-boundary`'s declarative API. The matching item in `frontend-refactor-plan.md` Phase 7 (file move + .jsx→.tsx conversion) becomes a no-op once this lands; mark superseded there.

### 3.6 Telemetry hook (D3 — promoted to in-scope, Lane G)

`logBoundaryFailure(boundary, err, context)` helper. Wired at zod parse-failure sites and error boundary `onError`. Captures `{ boundary, error, lane, step, userAction, timestamp }`. Logs to `console.warn` for now (structured payload); backend ingestion out of scope.

**Why now (not deferred)**: Lane G is already touching every error path. Promoting this helper from "deferred" to "in-scope" costs ~30 min CC; revisiting later means re-touching every error site for ~3 hours. The data shape is correct for future telemetry backend integration (Sentry / PostHog / `/api/metrics`). See TODOS.md for the production observability follow-up.

## 4. Lane plan

Every lane is **independently ship-able**, **browser-verified**, ends with green tests + green E2E.

### Lane A — Infrastructure (D9, C14, C15)

1. `npm install zod react-hook-form @hookform/resolvers @tanstack/react-query react-error-boundary`
2. `npm install -D @tanstack/react-query-devtools openapi-zod-client size-limit @size-limit/preset-app` (dev-only).
3. `<QueryClientProvider>` + conditional dev import of `<ReactQueryDevtools>` mounted in **`src/main.jsx`** (path correction from earlier draft).
4. `src/api/queries/index.ts` placeholder; `<HealthQuery>` smoke component (dev-only).
5. Top-level `<ErrorBoundary>` mounted with "재시도" fallback.
6. **`size-limit` config** + CI step (`.github/workflows/test.yml`): fails PRs that exceed the +50KB gzip budget vs `main` baseline.
7. **Bundle-size PR comment** (D6 cherry-pick): wire `andresz1/size-limit-action` (or equivalent) so every PR receives an inline comment with the gzip delta per chunk. Reviewers see size impact at code-review time without clicking into Action logs.
8. Type-checks pass; no usage yet.

**Acceptance**: `npm run build` clean; devtools toggles in dev only (verify by `npm run build && grep devtools dist/` returns no production hit); CI bundle-size step passes; size-limit PR comment shows up on the lane's own PR; `git diff src/` shows only additions.

### Lane B — zod schemas as canonical (D6, D7, D13)

1. Rewrite `wizard/schema.ts`: `*Schema` zod constants for every wizard slice. `type X = z.infer<typeof XSchema>` aliases preserve imports.
2. **`npm run gen:zod`**: pin `openapi-zod-client` (or chosen alternative) and produce `src/api/schemas-generated.ts` for REST endpoints. Add to `gen:types` in CI.
3. **`src/api/sse-schemas.ts`** (hand-written): `HostStreamEventSchema`, `CompositeStreamEventSchema`. Wire-shape (snake_case) + `.transform()` to client shape; absorbs `api/mapping.ts` responsibility for these surfaces.
4. **Update `fetchJSON` signature**: `fetchJSON(path, { schema: X, ... })` returns `z.infer<typeof X>`. Migrate all callers.
5. Add unit tests: each schema parses representative success + rejects malformed (missing field, wrong tag, invalid enum).

**Acceptance**: 0 net behavior change; existing imports of `wizard/schema.ts` still work; `gen:zod` clean; tests green.

### Lane B.5 — WizardState shape reconciliation (D11)

**Why**: existing drift between `wizardStore.ts:51-67` and `wizard/schema.ts:301` would cause Lane C's `safeParse` to reject every real user blob.

1. Decide which way the shape collapses (likely: store absorbs schema's nested `script: Script` + adds `playlistId: string | null`).
2. Update `INITIAL_WIZARD_STATE` in `wizardStore.ts` to match.
3. Update `migrateLegacyToSchema` to migrate flat `script: string` → nested `script: { paragraphs: [string] }` and pull `playlist_id` out of legacy step3 state.
4. Update Step3Audio.tsx to use `playlistId` (camelCase, matching schema) instead of `playlist_id`.
5. Tests: legacy v6/v7 blobs migrate cleanly to the reconciled v8 shape; no field loss.

**Acceptance**: `WizardStateSchema.safeParse(realUserBlob)` returns `{ success: true }` for all v6+ legacy data.

### Lane C — Persist hydrate validation (D11)

1. `migrate()` calls `WizardStateSerializedSchema.safeParse(p)`. On failure, log + return `INITIAL_WIZARD_STATE`. Drop `as WizardState` cast.
2. **`onRehydrateStorage` scrub**: `'streaming' | 'failed'` (or `'generating' | 'failed'` for voice) → `'idle'`. **`'ready'` preserved** — completed-generation progress survives refresh.
3. Replace legacy-key migration pre-pass (lines 123–176) with parse-or-reset.
4. Bump persist envelope to **version 8** (Lane B.5 already reconciled the shape; v8 is purely the validation hardening).
5. Tests: corrupted blobs → INITIAL_*; v7 → v8 round-trip; transient `'streaming'`/`'failed'` scrubbed but `'ready'` preserved.

**Acceptance**: corrupted localStorage doesn't crash any step page; completed-generation progress survives refresh.

### Lane D — RHF on Step 1 (D2, D6, D14)

**Phase 3 prereq** (D3): `frontend-refactor-plan.md` Phase 3 (per-slice selectors, drop `updateState`) ships as a **standalone PR before Lane D**. Required so Lane D can read `useHost()` + write `setHost()` cleanly.

1. RHF resolver = `zodResolver(HostInputSchema.refine(...))` — domain schema directly, no `HostFormSchema`.
2. **Step 1's existing streaming hook (`useHostGeneration`) STAYS**. RHF owns input fields only (prompt, builder chips, faceRef, advanced); generation state stays in zustand+hook (D14 #4).
3. Add `useFormZustandSync(form, slice, mapper)` helper (D14 #2): subscribes to slice updates → `form.reset(...)` for store→form direction.
4. `Step1Host.tsx`: replace inline `useState` with `useForm()` + `useFormZustandSync` + 300ms debounced `watch` → setHost.
5. `<WizardField>` wrapper added under `src/components/wizard-field.tsx`.
6. **Auto-save indicator** (D4 cherry-pick): `lastSavedAt: number | null` field added to wizard store; debounced watch stamps it on every successful draft write. New `<AutoSaveIndicator />` component reads `lastSavedAt`, renders a small "방금 전 저장됨" / "5초 전 저장됨" / "1분 전 저장됨" badge in the wizard footer. Tick the relative time every 10s.
7. Browser-verify: text mode + image mode + builder chip toggles + invalid-prompt zod error message + submit-disabled state + refresh-during-typing preserves draft (D2's user-flow check) + auto-save badge updates on edit.

**Acceptance**: Step 1 works exactly as before (streaming UX intact), with declarative validation messages, dirty/touched tracking, no inline `useState` for form fields, and a visible auto-save badge.

### Lane E — TanStack Query on uploads + progress polling (D5, D14)

**Verification gate for Lane F** (D1): if TQ doesn't feel right by Lane E acceptance, revisit the SSE bridge plan before Lane F.

1. `useUploadImage(kind)` mutation — uses zod-parsed `UploadResult`; `retry: 1, retryDelay: 1000` on idempotent uploads (D5). Stale-result rejection still managed via mutation `mutationKey` semantics.
2. `useTaskProgress(taskId)` query — `refetchInterval: (query) => ...` callback signature (TQ v5). Built-in retry on transient 5xx.
3. Convert `RenderLayout` and Step 2 product/background uploaders to new hooks. Delete `subscribeProgress` from `api/progress.ts` (keep schema there).
4. **Tab title progress** (D5 cherry-pick): inside `useTaskProgress`, write `document.title = "${progress}% — 영상 생성 중"` while polling; `useEffect` cleanup restores prior title on unmount/route change. Multi-tab users glance to check progress without switching tabs.
5. Browser-verify: render dispatch + progress polling + transient network drop recovery + upload retry on 503 + tab title updates while rendering, restored on navigate-away.

**Acceptance**: 0 callers of `subscribeProgress`; 0 callers of `useUploadReferenceImage`; render polling resilient to 1–2 dropped GETs; tab title reflects live progress while a render is in flight.

### Lane F — RHF on Steps 2 + 3, SSE bridged to TQ (D1, D12, D14)

1. RHF Step 2: `Step2CompositeFormSchema` discriminated on `background.kind`; `useFieldArray` for products. Existing composite SSE hook stays (RHF owns input fields only).
2. RHF Step 3: `Step3AudioFormSchema` discriminated on `voice.source`; script paragraphs via `useFieldArray`.
3. **SSE bridge**: `useHostStream` + `useCompositeStream` mutations write events via `qc.setQueryData(['host-stream', requestId])` where `requestId` is a client-generated UUID created before `mutate()` fires.
4. Each event parsed by zod schema (wire shape) and `.transform()` to client shape. Malformed event surfaces as a fatal SSE event (not silent `undefined`).
5. Components subscribe via `useQuery({ queryKey: ['host-stream', requestId], enabled: false })`.
6. Browser-verify: full Step 1 → Step 2 → Step 3 → Render flow; mid-flight SSE error surfaces as `<ErrorAlert>` inline.

**Acceptance**: 0 form-field `useState` in step pages. Existing E2E tests pass + new mode-switching E2E (Lane G) passes.

### Lane G — Error boundaries + recovery UX + 4 critical-path E2E (D3, D4, D8)

1. Per-page `<ErrorBoundary>` with reset on step change. **Delete `studio/ErrorBoundary.jsx`** (supersedes `frontend-refactor-plan.md` Phase 7 matching item).
2. `<ErrorAlert>` beside primary actions (host generate, composite generate, voice generate, render dispatch).
3. Upload retry preserves `File` ref across error states.
4. Voice clone failure → reset `voice.sample.state` to `'idle'` automatically.
5. **`logBoundaryFailure` helper** (D3 cherry-pick): new `src/lib/log-boundary-failure.ts`. Wired at every zod parse-failure site (API responses, persist hydrate) and every error boundary `onError`. Captures `{ boundary: 'top-level' | 'step' | 'mutation' | 'parse', error: { name, message, stack? }, context: { lane, step, userAction, taskId? }, ts }`. Logs structured payload to `console.warn` for now. Auth-token-shaped strings scrubbed from error messages and stacks before logging.
6. **4 named Playwright E2E specs** (D8) added to `frontend/e2e/`:
   - `refresh-during-typing.spec.ts` — type 200-char script in Step 3, refresh after 500ms idle, assert restored.
   - `back-during-render.spec.ts` — wizard → render → back; assert `voice.generation.state` is `'idle'`; re-click enqueues only one job.
   - `mode-switching.spec.ts` — Step 1 text↔image, Step 2 bg preset→upload→url→prompt, Step 3 voice tts↔clone↔upload; zod resolver rejects mode-cross fields.
   - `sse-fatal-error.spec.ts` — mock backend fatal event; assert `<ErrorAlert>` + retry → restart mutation.

**Acceptance**: every error path has a recovery affordance; 4 E2E specs green; no toast-only failures for primary actions; `logBoundaryFailure` fires structured payload at every error site (verify by triggering each kind in dev and inspecting console).

### Lane H — Type cleanup + done criteria sweep (D14)

1. **Delete `useAbortableRequest` from upload + polling consumers only** (D14 #1). It survives in SSE consumers (Step 1 host gen, Step 2 composite gen) where late-result rejection still needs explicit epoch logic.
2. Remove `[k: string]: unknown` escape hatch from `WizardState` (after Lane B.5 reconciles the shape).
3. Remove the 2 `as any` / `as unknown as` sites: `api/http.ts:15` (Vite env via `vite-env.d.ts` ambient declaration); `api-mappers.ts:134` (zod parse).
4. Audit: `git grep -nE 'as (any|unknown as)' src/` → 0 hits in production code.
5. Audit: `git grep -nE '\b(useState|useReducer)\(' src/wizard/steps/` → 0 form-field `useState`; transient UI (tab indices) may remain with documented justification.

**Acceptance**: Done-criteria diff comparable to existing `frontend-refactor-plan.md` Done section.

## 5. Sequencing vs. existing refactor plan

`frontend-refactor-plan.md` Phases 3–7 are not blocked by this plan. Suggested interleaving:

```
A → B → B.5 → C → Phase 3 (per-slice selectors, standalone PR) → D → E → F → Phase 5 (lucide) → G → Phase 4 → Phase 6 → Phase 7 → H
```

- **A, B, B.5, C** before **Phase 3**: schema + persist hardening pays off most before selectors are split.
- **Phase 3** (D3) ships as a **standalone prereq PR off main** — small, mechanical, low risk. Done before Lane D starts.
- **Phase 5 (lucide)** is fully orthogonal — slot anywhere.
- **Phase 4 (wrapper policy)** after **G**: the new RHF-aware `<WizardField>` is exactly the kind of wrapper Phase 4 enforces.
- **Phase 7 (studio/ delete)**: skip the matching ErrorBoundary item — already deleted in Lane G.

## 6. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `gen:zod` tool pick (openapi-zod-client vs alternatives) churns mid-Lane B | Medium | Low | Pin tool in Lane A's dep install; small evaluation up-front. |
| RHF + tagged unions awkward at sub-form boundaries | Medium | Medium | Lane D is a deliberate proof-of-concept on the simplest step. If Step 1 RHF feels worse than current, halt before Lane F. |
| TQ + SSE bridge feels awkward | Medium | Medium | Lane E (polling+upload) is the verification gate before Lane F commits the SSE bridge (D1). |
| Lane B.5 shape reconciliation drops a field | Low | High | Test against real user blobs from staging before Lane B.5 ships. Migration is idempotent and reversible. |
| Persist v7 → v8 migration regresses | Low | High | Lane B.5 + Lane C tests load real saved blobs from staging users. |
| Bundle size regression | Low | Low | Lane A's `size-limit` CI gate fails PRs exceeding +50KB gzip. |
| RHF mode-switch breaks union narrowing | Medium | Medium | `useWatch({ name: 'kind' })` as the source of conditional rendering; document convention in Lane D. |
| Backend OpenAPI drift mid-work | Low | High | `gen:zod` re-runs on demand; backend changes manifest as zod parse failures with full context (not silent `undefined`). |
| useFormZustandSync helper has subtle bugs | Medium | Medium | Cover with unit tests in Lane D; verify with `refresh-during-typing` E2E. |

## 7. Done criteria

- `zod`, `react-hook-form`, `@hookform/resolvers`, `@tanstack/react-query`, `react-error-boundary` installed and load-bearing.
- `@tanstack/react-query-devtools`, `openapi-zod-client`, `size-limit` installed as dev-only.
- 0 `as any` / `as unknown as` in `src/` (excluding `vite-env.d.ts` ambient).
- 0 hand-rolled `useState` for form fields in `src/wizard/steps/**`.
- 0 callers of `subscribeProgress`, `useUploadReferenceImage`.
- 0 callers of `useAbortableRequest` in upload + polling code; SSE consumers retain it (acknowledged scope).
- `studio/ErrorBoundary.jsx` deleted.
- Every API response parsed via a zod schema before reaching app code (REST schemas generated from OpenAPI; SSE schemas hand-written).
- localStorage hydrate cannot produce an invalid `WizardState`; completed-generation progress survives refresh.
- Every primary user action has an inline error + retry affordance.
- Browser-back during render does not produce a duplicate generation job.
- 4 critical-path Playwright E2E specs green in CI.
- `size-limit` CI gate green: bundle delta < 50 KB gzip vs `main` baseline.
- All existing tests pass; new tests cover schema parse failures, persist hydrate corruption, upload retry, polling backoff, RHF↔zustand sync, store→form sync.

## 8. Out of scope

**Out of scope for this plan**:
- Backend changes. Schemas reflect what the backend emits today; drift is a backend ticket.
- Suspense / RSC adoption.
- A new design system or component library.
- Test framework migration.
- Telemetry backend integration (just `console.warn` for now).
- Mobile / responsive re-layout work.

**Deferred (revisit after Lane G)**:
- **Upload progress UI** (D14 #3) — requires switching `uploadMultipart` from `fetch` to `XMLHttpRequest` to expose progress events. Not load-bearing for stability; skipped in this plan to keep Lane E small. Track as a follow-up Lane I if user feedback demands it.
- **Eventual `useAbortableRequest` deletion in SSE consumers** — would need a custom mutation cancel pattern. Reconsider if/when TQ adds native mutation cancel.
- **Production observability for TQ async surface** (D7 cherry-pick deferred) — TQ-level metrics on slow mutations and failing queries via `onSettled` hooks. Captured in `TODOS.md`. Pairs with a future backend `/api/metrics` ticket when ops bandwidth opens.
- **Access token refresh + proactive expiry handling** — current `authStore`/`http.ts` 401 path is "force logout, redirect to /login". Long-session users get bounced mid-flow. Refresh-token flow + single-flight refresh + 401 interceptor + optional pre-expiry background refresh. Backend support required (verify `/api/auth/refresh` exists first). Captured in `TODOS.md`. Out of this plan's "trust-eroding *frontend* bugs" frame; deserves its own PR with backend coordination.

**Surfaced for future tracking (CEO §3)**:
- Prompt injection in user-supplied prompts (Step 1 host prompt, Step 2 background prompt, Step 3 script). Backend-side concern; track when AI security ticket is opened.

## 9. Decisions locked

### From `/plan-eng-review` 2026-04-27 (architecture, code quality, tests, perf)

| ID | Decision | Plan section affected |
|---|---|---|
| D1 | SSE→TQ bridge KEPT; Lane E verifies TQ before Lane F | §3.3, §4 Lane E/F |
| D2 | RHF↔zustand sync: 300ms debounced watch + onSubmit; useFormZustandSync helper | §3.2, §4 Lane D |
| D3 | Phase 3 (per-slice selectors) ships as standalone prereq PR before Lane D | §5 |
| D4 | Adopt react-error-boundary; delete studio/ErrorBoundary.jsx in Lane G; supersede Phase 7 item | §3.5, §4 Lane G |
| D5 | TQ mutations: retry: 0 default; uploads opt-in retry: 1, retryDelay: 1000 | §3.3 |
| D6 | Use domain schemas (HostInputSchema etc) directly as RHF resolver; inline .refine() for submit-time | §3.1, §3.2 |
| D7 | Bake parse into fetchJSON({ schema: X }) returning z.infer<typeof X> | §3.1, §4 Lane B |
| D8 | +4 critical-path Playwright E2E specs (refresh-during-typing, back-during-render, mode-switching, sse-fatal-error) | §4 Lane G |
| D9 | size-limit CI gate added in Lane A; mechanical enforcement of <50KB gzip | §4 Lane A |
| D10 | Outside voice (Codex) ran 2026-04-27 | (this section) |
| D11 | Lane B.5 reconciles WizardState shape drift before Lane C; scrub list keeps `'ready'` | §3.4, §4 Lane B.5/C |
| D12 | SSE schema = wire shape (snake_case) + .transform(); cache key = client-generated requestId | §3.1, §3.3, §4 Lane F |
| D13 | Generate zod from OpenAPI for REST (`gen:zod`); hand-write only SSE schemas | §3.1, §4 Lane B |
| D14 | TQ scope honesty: useAbortableRequest survives in SSE; useFormZustandSync helper; drop upload-progress claim; Lane D keeps streaming | §3.3, §4 Lane D/H |

### From `/plan-ceo-review` 2026-04-27 (strategy, scope, expansions)

| ID | Decision | Plan section affected |
|---|---|---|
| C1 | Premise: stability-first justified by trust-eroding bug list (full plan, not targeted fixes) | §1 |
| C2 | Mode: SELECTIVE EXPANSION — surface adjacent wins as cherry-picks, neutral posture | (this section) |
| C3 | Cherry-pick ACCEPTED: `logBoundaryFailure` promoted from §3.6 deferred → Lane G in-scope | §3.6, §4 Lane G |
| C4 | Cherry-pick ACCEPTED: `<AutoSaveIndicator />` + `lastSavedAt` in Lane D | §3.2, §4 Lane D |
| C5 | Cherry-pick ACCEPTED: `document.title` render-progress writes in Lane E | §3.3, §4 Lane E |
| C6 | Cherry-pick ACCEPTED: `size-limit-action` PR comment in Lane A | §4 Lane A |
| C7 | Production observability deferred to `TODOS.md` (pairs with future backend `/api/metrics`) | §8, `TODOS.md` |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR (SELECTIVE EXPANSION) | 4 cherry-picks accepted (C3–C6), 1 deferred to TODOS.md (C7), premise verified (stability-first) |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found (resolved) | 14 substantive findings, all resolved (D11–D14 + 4 errata) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 14 decisions, 0 unresolved, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a — pure infra/architecture, no new UI design |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **CODEX**: ran as outside voice during eng review; 14 substantive findings surfaced, 4 auto-applied as errata (TQ v5 refetchInterval signature, main.jsx path, devtools `-D` + conditional import, Lane B/D7 wording conflict), 4 resolved via D11–D14 covering 8 cross-model tensions.
- **CROSS-MODEL**: cross-model agreement on the plan's overall thesis (zod + RHF + TQ); cross-model tensions on Lane C readiness (D11), SSE wire format (D12), OpenAPI rule violation (D13), TQ scope over-promise (D14) — all resolved with user input.
- **CEO REVIEW**: SELECTIVE EXPANSION mode added 4 adjacent wins to the locked plan: logBoundaryFailure now (C3), AutoSaveIndicator (C4), tab title progress (C5), bundle PR comment (C6). One item deferred to TODOS.md (production observability, C7).
- **UNRESOLVED**: 0
- **VERDICT**: CEO + ENG CLEARED — ready to implement.
