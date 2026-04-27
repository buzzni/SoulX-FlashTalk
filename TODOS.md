# TODOS

Deferred work captured during plan reviews. Each entry includes context for future-us.

## Production observability for TanStack Query async surface

**What**: Wrap `QueryClient` `defaultOptions.queries.onSettled` and `defaultOptions.mutations.onSettled` to emit `{ kind: 'query'|'mutation', key, durationMs, status, retryCount }` events. Send to `/api/metrics` (frontend) backed by a small backend collector (backend).

**Why**: `logBoundaryFailure` (Lane G, D3) captures *failures* with context. This is the *steady-state* counterpart — gives ops visibility into which mutations are slow, which queries fail most often, and how the new pipeline compares to the old hand-rolled patterns.

**Pros**:
- Ops triage becomes data-driven rather than vibes-driven.
- Perf regression hunting: spot a query that doubled in latency between deploys.
- Sanity check on the stability-plan thesis: did refactoring actually move metrics?
- TQ `onSettled` is the canonical wiring point — adoption cost is ~30 lines of frontend.

**Cons**:
- Requires backend `/api/metrics` endpoint that doesn't exist yet.
- Storage + retention policy need to be decided (PII, what gets dropped).
- Without dashboards, the data sits unused.

**Context**: Surfaced during `/plan-ceo-review` 2026-04-27 as D7 (cherry-pick deferred to TODOS). Pairs with `docs/ai-pipeline-stability-plan.md` once it ships and a backend ticket has bandwidth. The frontend half is ~1 hour CC; backend collector is ~1 day human / ~2 hours CC. Wait until ops *needs* this before building — premature observability is dashboards no one reads.

**Effort**: human ~2 days (frontend + backend) / CC ~3 hours total.

**Priority**: P3 (defer until ops bandwidth opens or production data starts mattering).

**Depends on / blocked by**: Frontend pipeline stability plan landed (so the wiring point exists). Backend `/api/metrics` endpoint design + ticket.

---

## Access token refresh + proactive expiry handling

**What**: Add refresh-token flow to `authStore.ts` + `api/http.ts`. Specifically:
1. Capture `refresh_token` and `expires_in` from `/api/auth/login` response (currently `LoginResponse` defines `expires_in` but does not store it; no `refresh_token` field exists).
2. Persist `expiresAt = Date.now() + expires_in * 1000` alongside the access token in localStorage.
3. Add a single-flight `refreshAccessToken()` call that hits `POST /api/auth/refresh` with the refresh token, swaps in the new access token, and resolves any other in-flight requests waiting on it.
4. Wire a 401 interceptor in `api/http.ts`'s `parseResponse`: if response is 401 *and* a refresh token exists *and* the request was not `/api/auth/refresh` itself, attempt one refresh + retry the original request. Only fall through to `onUnauthorized` (force logout) if the refresh fails.
5. Optional: schedule a background refresh ~60s before `expiresAt` so users in long sessions never hit a 401 in the first place.

**Why**: Today, when an access token expires mid-session, the next request 401s and the user is force-logged out via `setUnauthorizedHandler` redirect to `/login?next=...`. They lose flow even though wizard state survives via `zustand/persist`. For users with long generation sessions (videos can take minutes), this happens often enough to feel broken.

**Pros**:
- Long sessions stop bouncing users to login mid-flow.
- Stability plan's "trust-eroding bug" frame extends naturally — silent re-auth is the same kind of "things just work" win as auto-save.
- 401-interceptor + single-flight pattern is well-trodden; reference implementations everywhere.
- Cleanly composes with TanStack Query: refresh happens inside `fetchJSON`, so TQ retry/dedup just sees the eventual success.

**Cons**:
- Requires backend support — `/api/auth/refresh` endpoint + refresh token issuance on login. Verify before frontend work starts (`grep -r refresh app.py modules/auth*` or check OpenAPI spec).
- Refresh tokens stored in localStorage have the same XSS exposure as access tokens (no httpOnly cookie option in this SPA architecture today). Document the trade-off; full hardening is its own work item.
- Single-flight semantics (multiple concurrent 401s share one refresh) require careful Promise plumbing. Off-the-shelf is fine but worth one careful read-through.

**Context**: Surfaced during stability-plan review 2026-04-27 when reviewing auth posture. Current code at `frontend/src/stores/authStore.ts:26-31` (LoginResponse, no refresh_token) + `frontend/src/api/http.ts:142-145` (401/403 → unconditional onUnauthorized). Dependency on backend means this is not pure-frontend work; cannot be done unilaterally.

**Effort**: human ~2 days (backend endpoint + frontend) / CC ~3 hours total (assuming backend exists). Add ~half a day if backend refresh endpoint must also be designed/built.

**Priority**: P2 (silent UX degradation; affects long-session users; user-trust impact comparable to the bugs the stability plan is fixing).

**Depends on / blocked by**: Backend confirmation — does `/api/auth/refresh` exist or does login issue a `refresh_token`? Step 1 of execution is grep + read, not code.

---

## Steps 2 & 3 RHF migration + SSE bridge end-to-end

**What**: Apply the same RHF treatment to `Step2Composite.tsx` (422 lines) and `Step3Audio.tsx` (590 lines), and wire the `useHostStream` / `useCompositeStream` TQ-bridged consumers (from `src/api/queries/use-host-stream.ts`) into the actual generation buttons.
1. **Step 2 RHF**: `useForm({ resolver: zodResolver(Step2CompositeFormSchema) })` discriminated on `background.kind`. `useFieldArray` for products. Tabs control a hidden `kind` field via `useWatch({ name: 'background.kind' })`; conditional sub-form renders the matching variant.
2. **Step 3 RHF**: same shape, `Step3AudioFormSchema` discriminated on `voice.source` (tts / clone / upload). `useFieldArray` for `voice.script.paragraphs[]`. Voice-clone failure auto-resets `voice.sample.state = 'idle'` via mutation `onError`.
3. **SSE bridge consumption**: `Step1Host` and `Step2Composite` create a client `requestId = useMemo(() => crypto.randomUUID(), [/* per dispatch */])`, fire `useHostStream().mutate({ input, requestId })`, and read events via `useHostStreamEvents(requestId)`. Wire mid-stream fatal events to `<ErrorAlert>` (already in `src/components/error-alert.tsx`).
4. **Existing `useHostGeneration` / `useCompositeGeneration`**: keep the in-memory state machine (variants array, prevSelected) since those hooks already manage it well; the bridge surface is for the *event log* (debug overlay, fatal-error inline alert, future telemetry).
5. Each step gets a Vitest spec for the resolver + a Playwright run on `mode-switching.spec.ts` and `sse-fatal-error.spec.ts` (specs already exist, this just makes them pass against the real components).

**Why**: Lane F shipped the SSE→TQ bridge as a parallel surface but no UI consumes it yet. Lane D shipped helpers but no Step page uses them. The follow-up PRs that *consume* this scaffolding are where the user-visible improvement lands — declarative validation messages, no toast-only mutation failures, mode-switch type safety.

**Pros**:
- Plan §7 done-criteria flips from "0 form-field useState in wizard/steps" claimed-but-not-asserted to actually green.
- Inline `<ErrorAlert>` becomes load-bearing for every primary action (host gen, composite gen, voice gen, render dispatch). Today the toast-only failure regression is technically still possible because the alerts aren't wired.
- The 4 Playwright specs (`refresh-during-typing`, `back-during-render`, `mode-switching`, `sse-fatal-error`) start passing against real components, not stubs.

**Cons**:
- Largest follow-up by churn — touches ~1000 lines across two step pages. Risk of merge-conflict if other Step 2/3 work lands in parallel.
- Step 3's `useFieldArray` for `voice.script.paragraphs[]` is the trickiest part; paragraph reorder/insert/delete need to round-trip through the schema (`ScriptSchema`).
- `useFormZustandSync` reset semantics on Step 2 will hit a real edge case: composite generation completing mid-edit fires `setComposition` which the form should pick up, but the user's in-flight `composition.settings.direction` typing should NOT be reset. The Lane D unit test catches reference-equality drops; a Vitest spec for the slice-partial-update path is required here.
- Voice-clone auto-reset (`sample.state = 'idle'` on failure) is one of those "users hate manual recovery" wins, but it has to run via mutation `onError` not `onSettled` (don't reset on success).

**Context**: Deferred from PR #8 / Lane F. All schemas, hooks, and helpers are merged. Plan §4 Lane D step 6 + Lane F + Lane G all have step-by-step instructions. Total work compresses well with CC because the helpers are already in place; the human estimate balloons due to the breadth of components touched.

**Effort**: human ~3 days / CC ~2 hours. Recommend splitting into two PRs: Step 2 first (validates the pattern with `useFieldArray` for products), then Step 3 (more complex with voice-source discriminator).

**Priority**: P2 (high user-visible impact; the headline acceptance criteria from the plan).

**Depends on / blocked by**: Step 1 RHF wire-up (the prior TODO entry). That follow-up exercises the helper API end-to-end and surfaces any helper bugs cheap; without it, Step 2/3 are debugging two layers at once.

---

## Unify `WizardState` between `wizard/schema.ts` and `stores/wizardStore.ts`

**What**: Replace the `interface WizardState` declaration at `frontend/src/stores/wizardStore.ts:51-69` with `export type { WizardState } from '../wizard/schema'`. Delete the `as unknown as WizardState` cast at `frontend/src/stores/wizardStore.ts:307` (last cast in production code; pure relief work for Lane H's done-criteria audit).

**Why**: Lane B converted `wizard/schema.ts` to zod schemas with `type WizardState = z.infer<typeof WizardStateSchema>`. Lane B.5 reconciled the store's interface to match. They are now content-equivalent, just two declarations of the same shape. The double-declaration forces a `as unknown as WizardState` cast inside `migrateWizardEnvelope`'s safeParse return (the parsed.data is structurally identical but TS sees them as nominally different).

**Pros**:
- One canonical `WizardState` type. Lane H's 0 'as any' / 'as unknown as' audit becomes truly green in production code.
- Simplifies onboarding — new contributor doesn't have to read both files to understand the state shape.
- Eliminates a real maintenance hazard: today, adding a field to `wizardStore.ts:51` without also adding it to `WizardStateSchema` produces a runtime drift Lane C's safeParse would catch only at hydrate time.

**Cons**:
- Verify zustand's `set` typing accepts the zod-inferred type cleanly — discriminated unions inferred from `z.discriminatedUnion` should work but worth checking against zustand v5's setter signature.
- Test fixture casts in `stores/__tests__/wizardStore.migrate.test.ts` use `as unknown as Record<string, unknown>` — those stay (testing shape mutations on a strict type requires the double-cast to pierce).

**Context**: Lane H follow-up explicitly noted in the PR #8 commit message ("would require unifying schema.ts and wizardStore.ts WizardState declarations into a single canonical export"). All groundwork is done; this is a single-file change plus a typecheck pass.

**Effort**: human ~30 min / CC ~10 min.

**Priority**: P3 (pure cleanup; no user-visible impact; maintenance-quality of life).

**Depends on / blocked by**: Nothing.

---

## Remove legacy `subscribeProgress` export from `api/progress.ts` + `studio/api.js`

**What**: Delete the `subscribeProgress` function (`frontend/src/api/progress.ts:37-103`) and its re-export at `frontend/src/studio/api.js:61`. Keep the file because `ProgressEvent` and the polling constants (`PROGRESS_POLL_MS`, `PROGRESS_MAX_CONSECUTIVE_ERRORS`) might still be referenced; verify with `grep -rn "ProgressEvent\|PROGRESS_POLL_MS" src/` and inline whatever remains. Final state: `api/progress.ts` either has zero exports (delete the file entirely) or a thin schema-only module.

**Why**: Lane E migrated the only production caller (`useRenderJob`) from `subscribeProgress` to `useTaskProgress`. The export still exists but no consumer references it. Stale exports drift over time — someone doing a "let me wire up progress" search lands on the old function instead of the TQ hook.

**Pros**:
- Closes a Lane H done-criteria item ("0 callers of `subscribeProgress`" → also drop the function definition itself).
- Removes ~75 lines of polling-loop code that's no longer the canonical path.
- Forces any future progress consumer to go through TanStack Query (which gives them retry, dedup, devtools for free).

**Cons**:
- Need to confirm no E2E spec or test fixture imports it. Grep first: `git grep -rn 'subscribeProgress'` (excluding `__tests__/api_abort.test.js` which tests the legacy function and should also be deleted in the same commit, per the "tests follow code" principle).
- The `PROGRESS_POLL_MS = 1500` constant lives there; `useTaskProgress` hard-codes `1500` separately. After the delete, decide: import from a shared constants module, or accept the duplication.

**Context**: Lane H follow-up explicitly noted: "subscribeProgress: still exported from api/progress.ts; 0 callers in the wizard render path (Lane E migrated the only consumer). Final removal awaits a follow-up commit." Pure cleanup, mechanical.

**Effort**: human ~20 min / CC ~5 min.

**Priority**: P3 (cleanup; landed alongside the WizardState unification would be a clean "Lane H finalization" PR).

**Depends on / blocked by**: Nothing.

---

## Run the 4 critical-path Playwright specs in CI

**What**: Add a Playwright job to `.github/workflows/test.yml` that runs `frontend/e2e/refresh-during-typing.spec.ts`, `back-during-render.spec.ts`, `mode-switching.spec.ts`, and `sse-fatal-error.spec.ts` against a built dev server.
1. New job in CI: `playwright-e2e`. Build frontend (`npm run build`), serve via `npm run preview` (or a Playwright `webServer` config), run `npx playwright test e2e/`.
2. Cache the Playwright browser binaries (`actions/cache` keyed on `playwright-core` version from `package-lock.json`) to keep the job under 3 minutes.
3. **All 4 specs gate on Step 1/2/3 RHF wire-up** (verified 2026-04-27 against `main` post-PR-8): `refresh-during-typing` types into a Step 3 `<textarea>` and asserts the value survives a reload, but Step 3's script editor doesn't yet bridge keystrokes through RHF→zustand fast enough for the 500ms idle window — fails as `unexpected value ""`. `back-during-render`'s scrub assertion (`['generating', 'idle']`) does pass, but the follow-up `getByRole('button', name: /음성 생성|만들기/)` matches multiple buttons (Step 2's "합성 이미지 만들기" + Step 3's "음성 만들기") and fails strict-mode. `mode-switching` and `sse-fatal-error` need RHF resolver + `<ErrorAlert>` wiring. So the actual ordering is: Step 1 RHF → Step 2/3 RHF → tighten button selector in `back-during-render` → land all 4 in CI.

**Why**: Lane G shipped the spec files as documented contracts but they don't run anywhere. Plan §7 done-criteria says "4 critical-path Playwright E2E specs green in CI" — currently false. A regression in persist scrub or RHF reset semantics ships silently.

**Pros**:
- Makes the spec files load-bearing rather than aspirational.
- Catches the regressions they were written to catch: persist `'streaming'` not scrubbed, RHF defaults overriding store-restored drafts, mode-switch tagged-union leakage, fatal SSE going to toast-only instead of `<ErrorAlert>`.
- Once unblocked, all 4 specs guard regressions in persist hardening, RHF reset semantics, mode-switch tagged-union leakage, and fatal-SSE inline alerts in one CI gate.

**Cons**:
- Playwright on CI adds ~2-3 minutes per PR (cache hit) or ~5 minutes (cache miss). Tolerable but real.
- Authentication: the specs `seedAuth(page)` by writing fake JWT into `localStorage` and mock `/api/auth/me`. That assumes the auth stack respects localStorage seeding pre-mount; verify with one trial run before finalizing.
- The wizard requires a backend for some endpoints even with mocks (e.g. `/api/playlists` for Step 3). Either expand the mock surface in each spec or stand up a stub backend — current spec files mock per-test, which is the pragmatic path.

**Context**: Lane G shipped the 4 spec files but the workflow didn't add a Playwright job. PR #8 test plan listed "Run the 4 new Playwright specs against staging" as deferred. Frontend job already runs `npm run test -- --run` (Vitest); this is a separate Playwright job.

**Effort**: human ~half a day (workflow + cache config + first-run debugging) / CC ~30 min for the workflow + skip-flagging, plus per-spec debug as RHF lands.

**Priority**: P2 (closes a stated done-criteria item).

**Depends on / blocked by**: Step 1 RHF wire-up + Step 2/3 RHF migration (both TODO entries above). All 4 specs need RHF for their assertions to pass; landing this entry standalone would just add a permanently-red CI job.


## Completed

### Step 1 RHF wire-up (consume Lane D helpers in HostTextForm + HostReferenceUploader)

**Completed:** feat/step1-rhf (2026-04-27)

`Step1Host.tsx` now owns a `useForm({ resolver: zodResolver(HostFormValuesSchema), defaultValues: hostSliceToFormValues(host), mode: 'onBlur' })` instance. `HostTextForm`, `HostReferenceUploader`, and `HostControls` consume `useFormContext` and lost their value/onChange prop API. `useFormZustandSync` keeps the form mirroring the slice (hard reset, not `keepDirtyValues:true` — that broke tagged-union mode swaps and was reverted). `useDebouncedFormSync` got change-detection via a serialized `lastEmittedRef` to suppress no-op flushes from `form.reset` round-trips. `submit` runs through `form.handleSubmit` and reuses `toHostGenerateRequest` from `wizard/api-mappers.ts` instead of an inline IIFE. The `mode-switching.spec.ts` selector was fixed (`role="tab"` → `role="radio"`) and a reverse `image → text` spec was added; both pass. `frontend/src/wizard/form-mappers.ts` is the new bidirectional mapper file with 4 unit tests. `useFormZustandSync` got 2 new regression tests (no-op suppression + tagged-union swap) so the keepDirtyValues bug can't sneak back. Final test counts: 212 → 214 vitest pass, mode-switching e2e pass (both directions), browser visual confirmed.
