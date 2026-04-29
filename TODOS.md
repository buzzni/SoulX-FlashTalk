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

## Step 3 RHF migration + SSE bridge end-to-end

**What**: Apply the same RHF treatment shipped on `Step1Host.tsx` (PR #13) and `Step2Composite.tsx` (PR #16) to `Step3Audio.tsx` (590 lines), and wire the `useHostStream` / `useCompositeStream` TQ-bridged consumers (from `src/api/queries/use-host-stream.ts`) into the actual generation buttons.
1. **Step 3 RHF**: `Step3AudioFormSchema` discriminated on `voice.source` (tts / clone / upload). `useFieldArray` for `voice.script.paragraphs[]`. Voice-clone failure auto-resets `voice.sample.state = 'idle'` via mutation `onError`.
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


## HTTP Range (206) support for `/api/videos/{task_id}` so `<video preload="metadata">` actually fetches metadata only

**What**: Add HTTP byte-range request handling to the video file endpoint in `app.py` (`/api/videos/{task_id}`). FastAPI's default `FileResponse` does not implement `Range` / `206 Partial Content` — clients that send `Range: bytes=0-...` get the whole file back as a 200. Replace with a streaming response that honors `Range` headers (or use a library like `fastapi-range-response` / a hand-rolled `StreamingResponse` with start/end byte offsets), and verify `Accept-Ranges: bytes` appears in the response headers.

**Why**: `HomePage.tsx` `RecentRow` renders up to 4 recent video thumbnails with `<video src={videoUrl} preload="metadata" muted />` and now reads `e.currentTarget.duration` via `onLoadedMetadata` to display the playback length. Browsers honor `preload="metadata"` only when the server supports byte-range — they fetch the moov atom (~tens of KB) and stop. Without Range, every recent-works card downloads the full MP4 (often several MB) on home page load. With 4 cards on the home page and more on `/results`, this is a hidden bandwidth amplification that scales linearly with thumbnail count.

**Pros**:
- Home page initial load drops from ~4× full-video downloads to ~4× metadata-only fetches (likely 10-100× bandwidth reduction depending on video size).
- `<video>` scrubbing and seek-to-position work correctly in the result page player without re-downloading the whole file.
- Mobile/cellular users stop burning data on metadata extraction — currently every home visit silently pulls megabytes per card.
- Standards-compliant: every modern HTTP client and CDN expects 206 support for media URLs.

**Cons**:
- Requires backend changes — handler rewrite, header parsing, edge cases (multi-range requests, malformed `Range` headers, end-of-file boundary). Not a one-line fix.
- Need to verify whatever proxy/CDN sits in front of the backend (nginx, CloudFront, etc.) doesn't strip or mishandle `Range` — testing path goes through the real network stack.
- New tests required: full-file GET, `Range: bytes=0-1023`, `Range: bytes=N-` (open-ended), invalid range → 416.

**Context**: Surfaced during `/simplify` efficiency review of PR #12 (chore/home-cards-polish, 2026-04-27). The frontend change shipped using `preload="metadata"` with a duration-extraction state hook, on the assumption that the endpoint supports Range — which inspection of `app.py:1439-1451` (FastAPI `FileResponse`) showed it does not. The frontend works correctly (duration displays) but pays a hidden full-download cost per thumbnail until this lands.

**Effort**: human ~2-3 hours (rewrite handler + add tests + verify through proxy) / CC ~30 min for the handler + tests.

**Priority**: P3 (perf optimization, not a correctness bug — defer until home page bandwidth shows up in metrics or someone files a slow-load complaint).

**Depends on / blocked by**: None.


## Completed

### Step 1 RHF wire-up (consume Lane D helpers in HostTextForm + HostReferenceUploader)

**Completed:** feat/step1-rhf (2026-04-27)

`Step1Host.tsx` now owns a `useForm({ resolver: zodResolver(HostFormValuesSchema), defaultValues: hostSliceToFormValues(host), mode: 'onBlur' })` instance. `HostTextForm`, `HostReferenceUploader`, and `HostControls` consume `useFormContext` and lost their value/onChange prop API. `useFormZustandSync` keeps the form mirroring the slice (hard reset, not `keepDirtyValues:true` — that broke tagged-union mode swaps and was reverted). `useDebouncedFormSync` got change-detection via a serialized `lastEmittedRef` to suppress no-op flushes from `form.reset` round-trips. `submit` runs through `form.handleSubmit` and reuses `toHostGenerateRequest` from `wizard/api-mappers.ts` instead of an inline IIFE. The `mode-switching.spec.ts` selector was fixed (`role="tab"` → `role="radio"`) and a reverse `image → text` spec was added; both pass. `frontend/src/wizard/form-mappers.ts` is the new bidirectional mapper file with 4 unit tests. `useFormZustandSync` got 2 new regression tests (no-op suppression + tagged-union swap) so the keepDirtyValues bug can't sneak back. Final test counts: 212 → 214 vitest pass, mode-switching e2e pass (both directions), browser visual confirmed.

### Step 2 RHF wire-up (Step2Composite + BackgroundPicker + ProductList + CompositionControls)

**Completed:** feat/step2-rhf (2026-04-27)

`Step2Composite.tsx` is now a `FormProvider` container with `useForm({resolver: zodResolver(Step2FormValuesSchema), mode:'onBlur'})`. The form spans three store slices — `products`, `background`, `composition.settings`. The container subscribes to `composition.settings` (NOT the full `composition`) via a narrow zustand selector so SSE candidate events during composite streaming can't trigger `form.reset` and wipe in-progress edits. CRITICAL bug caught during /simplify pre-landing review (formSlice memo originally depended on the full composition); fixed and committed with a Playwright regression guard (`step2-rhf.spec.ts` "typed direction survives a simulated composition.generation mutation"). `BackgroundPicker` swaps the 4-way `background.kind` tagged union via `setValue`, `ProductList` uses `useFieldArray` for drag/add/remove with per-row source-kind swaps via `update(idx, ...)`, and `CompositionControls` uses `Controller` for shot/angle/temperature plus `register` for the direction textarea (with merged-ref pattern to keep the N번 caret-insert chip working). Submit runs through `form.handleSubmit` and parallelizes product + background uploads via `Promise.all`, then reuses `toCompositeRequest` from `wizard/api-mappers.ts`. `onChange` writes via a single `updateState` call (atomic 3-slice batch — one render, one selector run per subscriber). Dropped dead surface: `update?` prop, `Step2Slice`/`step2SliceToFormValues`/`Step2WriteTargets`/`formValuesToStep2WriteTargets`, `_props: ProductListProps`. Reused: `uploadFileFromAsset` + `localAssetFromUploadFile` (upload-tile-bridge), `isProductReady` (schema), `productPreviewUrl` (now exported from ProductList for CompositionControls). Final test counts: 216 → 225 vitest (+9 new api-mapper tests, +2 schema tests, -4 stale step2 mapper tests), 3/3 step2-rhf e2e PASS (preset→prompt swap, prompt→preset reverse, streaming-during-typing regression).

## Admin page v2 — A/B 도구 + RUBRIC integration + 8 inference params hot-tune

**What**: MVP admin page (prompt only) 가 lever 입증한 후 격상.

1. **A/B 동시 enqueue 도구** — 같은 host+audio 입력으로 prompt N variants 동시 enqueue, result grid 비교 UI
2. **RUBRIC 점수 누적** — eval/step3 framework 통합. 각 task 에 score 매기면 prompt 별 yes-rate / mouth_over_articulation 통계
3. **8 inference params hot-tune** — `flash_talk/inference.py:12` module-level `infer_params` 를 lazy callable 로 refactor. subprocess (USP) 환경 도 admin doc read. sample_steps / motion_frames_num / sample_shift / color_correction_strength / audio_trim_pad_ms / lipsync_audio_offset_ms / default_seed
4. **wav2vec_dir hot-swap** — pipeline reload + GPU memory churn 처리 logic. allowlist enum (free path 보안 footgun)
5. **Multi-prompt library** — 라벨, 즐겨찾기, history, diff view

**Why**: MVP admin page 가 prompt lever 입증 입증되면 evidence mechanism 자체가 다음 lever. codex outside voice (T5) 가 지적한 핵심 — A/B + RUBRIC 없으면 admin tooling 이 noise 만 만듦.

**Pros**:
- A/B 가 manual replay-and-compare 시간 90%+ 단축
- RUBRIC 통합으로 객관적 lever 입증 (1134bc2 류 함정 회피)
- 8 inference params hot-tune 으로 sample_steps / motion_frames 등 다른 axis 도 admin 에서

**Cons**:
- inference.py module-level refactor 가 subprocess (USP) 환경에서 복잡
- wav2vec_dir hot-swap 은 pipeline reload + GPU 위험. 잘못하면 OOM
- A/B 도구가 batch enqueue + result grid UI 까지 커지면 1주 작업

**Context**: 2026-04-28 plan-eng-review + codex outside voice 에서 도출. Design doc: `~/.gstack/projects/buzzni-SoulX-FlashTalk/jack-main-design-20260428-142619.md`. MVP (prompt only) 가 lever 입증된 후에만 진행. 입증 못 하면 다른 lever (HeyGen / Hallo2 / fine-tune) 로 점프.

**Effort**: human ~1-2 weeks / CC ~3-5 days total.

**Priority**: P2 (defer until prompt lever 입증).

**Depends on / blocked by**: MVP admin page (prompt only) 구현 + 5-7번 prompt 변형 시도 + RUBRIC blind score 의 yes-rate 평가.

---

## Wizard 입력 UX + prompt capability 재검토 (B1/B3/C2/C3)

**What**: 현재 wizard UI에 노출돼 있거나 노출 가치가 있는 입력값들의 **사용자 명료성 + 모델 capability 활용**을 design 시점에서 재검토. 4가지 묶음:

1. **B1 Step 1 strength UI** (`HostReferenceUploader.tsx:37-40`) — 4단계 칩 (느슨하게/참고만/가깝게/똑같이)이 0.15/0.45/0.7/0.95에 매핑. 사용자가 같은 값으로 4장 후보를 받으므로 strength 효과를 비교 학습 불가능. 옵션: 라벨 아래 결과 영향 1줄 설명 (γ) / 4장을 4 strength로 분산 생성 (α) / hover 비교 이미지 (β).
2. **B3 Step 3 advanced 미리듣기** (`VoiceAdvancedSettings.tsx`) — stability/style/similarity/speed slider 변경 시 미리듣기 부재 → "음성 만들기" 다시 눌러야 들음. 짧은 sample script + debounce 방식 도입 검토. ElevenLabs character 비용 분석 필요.
3. **C2 image-mode negativePrompt** (`schema.ts:HostInputSchema` image variant) — text mode에는 negativePrompt 입력 있음, image mode에는 없음. backend는 mode 무관하게 처리. 대칭 회복 가치 검토.
4. **C3 FlashTalk T5 prompt 노출** (`config.py:45`) — 모든 영상이 default 'calmly speaking' prompt 동일. Step 3에 "영상 톤" 3-preset segmented 노출 검토. lip-sync 품질 영향 사전 실험 필요.

**Why**: `/plan-eng-review` 2026-04-29 매핑 일관성 정리 (`specs/wizard-input-prompt-coherence/plan.md`)에서 도출. 매핑 cleanup은 PR 분리, UX 결정은 design-review 영역으로 이관됨. 묶음으로 검토해야 wizard 전체 UX 일관성 확보.

**Pros**:
- 사용자가 입력한 값이 "결과를 어떻게 바꾸는지" 명료해짐 → 후보 선택 학습 가속
- text/image mode UX 비대칭 해소
- FlashTalk 영상 톤 자유도 = 동일 호스트로 다양한 콘텐츠 톤 가능

**Cons**:
- B3는 ElevenLabs character 비용 증가 가능성 (debounce 설정에 의존)
- C3는 lip-sync 품질에 영향 — default prompt 변경 자체가 위험
- 4건 묶음 처리 시 PR scope ↑

**Context**: `specs/wizard-input-prompt-coherence/plan.md` 참고. plan-eng-review에서 매핑 정리만 채택하고 UX/capability 결정은 모두 defer. 다음 단계는 `/plan-design-review specs/wizard-input-prompt-coherence/plan.md` 또는 별도 design 세션.

**Effort**: human ~1주 / CC ~6-8시간 (각 항목 디자인 + 구현 + 테스트).

**Priority**: P3 (매핑 cleanup 먼저 land 후 진행).

**Depends on / blocked by**: 매핑 cleanup PR (A1+A2+A3+A4) 머지. C3는 lip-sync 품질 사전 실험 (3 preset prompt × 5 영상 비교).

---

## PR S3+ cutover follow-ups

**What**: Items deferred from the S3 migration commits (C1–C13). All
non-blocking for the cutover itself but should land before the
PoC demo handoff goes wider than the current customer.

1. **`generate_conversation_task` dual-input handling** — C9 left
   conversation worker on absolute-path-only inputs. PoC demo doesn't
   exercise the conversation page much, so it's fine through cutover,
   but frontend C9 changes will break it the moment a user submits a
   conversation with storage_key inputs. Mirror the
   `_resolve_input_to_local` + `_cleanup_input_tempfiles` pattern from
   `generate_video_task` (~30 lines).

2. **task_states cleanup post-upload** — C7 review #4 / C10 review #4:
   `task_states[task_id]["output_path"]` keeps pointing at the LocalDisk
   mp4 even after the worker has uploaded to S3. `/api/videos` then
   serves the local copy in preference to the S3 redirect. Pop the dict
   entry once `_upload_video_with_retry` returns OK.

3. **Local OUTPUTS_DIR cleanup cron** — C7 review #3: inference results
   stay in OUTPUTS_DIR forever post-cutover even though S3 has the
   canonical copy. Disk-full risk on the GPU box. Either a daily cron
   that deletes mp4s older than 7 days, or hook the cleanup into
   `_upload_video_with_retry` success path.

4. **`generate_video_task` cancel-safe try/finally** — C9 review #2:
   `_cleanup_input_tempfiles` runs in the success path and the except
   branch but not on `asyncio.CancelledError` / `KeyboardInterrupt`.
   PoC demo doesn't exercise queue cancel often, but the temp leak
   accumulates across cancels. Wrap the body in try/finally (large
   indent diff but mechanical).

5. **frontend strict schema migration** — C8 review #5: `_serialize` /
   `_public` now emit `storage_key`. If frontend zod schemas are strict
   they'll reject the new field. Either add `storage_key` to the schemas
   or set them to `extra='allow'`. Same for `/api/upload/*`'s
   `storage_key` / `url` additions.

6. **`/api/files` legacy bare-name backfill** — C10 review #7:
   pre-PR3 manifests stored URLs like `/api/files/host_a.png`
   (no bucket prefix). On S3 cutover those resolve to nothing.
   Either a one-shot DB scan that rewrites the URLs to the new
   `outputs/...` shape, or extend the S3 branch in `/api/files` to
   probe `uploads/` for bare names.

**Why**: The cutover is safe to ship without these — every item is
either rare in the PoC demo (#1, #4) or has a graceful fallback
(#5, #6) or is a slow-burn cost (#2, #3). But each needs the
attention before the migration is "done done".

**Effort**: human ~1 day total / CC ~3 hours total.

**Priority**: P2 (post-cutover follow-ups, before wider rollout).

**Depends on / blocked by**: PR S3+ C13 cutover land.

---

## /api/host/generate/stream storage key ownership hardening (P1)

**What**: Apply the `user_owns_storage_key(user_id, key)` primitive (introduced in saved-host PR1, `utils/security.py`) to `/api/host/generate/stream` for `faceRefPath`, `outfitRefPath`, and `styleRefPath` (`app.py:3503` area). Today `_validate_and_resolve` only validates storage-key shape — a user can pass another user's `outputs/<their-uuid>` key and generate a derivative.

**Why**: Found by codex during saved-host /plan-eng-review (2026-04-29). Saved-host PR1 only fixes `/api/hosts/save`; the same hole survives in the variant-generate flow. Result: unauthorized derivative-generation path against any user whose storage_keys are guessable or leaked.

**Pros**:
- Closes the broader cross-user image-clone surface, not just the saved-host symptom.
- Single primitive, applied consistently → low cognitive overhead going forward.
- Backed by codex P0 finding (cross-model consensus).

**Cons**:
- Backfill scope: every endpoint that takes a storage_key arg needs the primitive applied. Touches `/api/host/generate/stream`, possibly composite/audio endpoints.
- Test work: cross-user 거부 케이스를 endpoint마다.

**Context**: `_validate_and_resolve` (`app.py:259`) only validates SHAPE via `safe_input_value` — `utils/security.py` doesn't currently know which user owns which key. The saved-host PR introduces `user_owns_storage_key(user_id, key) -> bool` based on bucket-prefix conventions (`outputs/<user_id>/...`, `uploads/<user_id>/...`, `examples/` shared). Apply to all key-accepting endpoints.

**Effort**: human ~1일 / CC ~1시간 (audit + apply + tests).

**Priority**: P1 (security; expand within ~1 sprint of saved-host PRs landing).

**Depends on / blocked by**: Saved-host PR1 (introduces the primitive).

---

## /api/hosts list pagination + cap (P3)

**What**: `studio_saved_host_repo.list_for_user` (`modules/repositories/studio_saved_host_repo.py:79`) loads all rows + signs URL for every item. v1엔 사용자 N<10 기대지만, power user가 50+ 만들면 sidebar count + library page 둘 다 무거워짐. Pagination (skip/limit) 또는 count-only endpoint 분리.

**Why**: Codex finding (saved-host /plan-eng-review 2026-04-29). 현재 사용자 수 작아서 즉시 문제는 아니지만, scaling cliff.

**Pros**: 
- Library page lazy load (200+ host에서도 빠름).
- Sidebar count는 `GET /api/hosts/count` 같은 lightweight endpoint로 분리 가능.

**Cons**:
- v1엔 over-engineering 가능성. N<50일 때 ROI 0.

**Context**: react-query는 already pagination 지원 (`useInfiniteQuery`). 추가 cost 작음.

**Effort**: human ~3시간 / CC ~30분.

**Priority**: P3 (defer until N>50 user 발생).

**Depends on / blocked by**: Saved-host PR1 land.

---

## api-mappers.ts:61 face-only mode='style-ref' contract clarification (P2)

**What**: `frontend/src/wizard/api-mappers.ts:61`에서 image input + faceRef only가 mode='style-ref' but faceRefPath 보냄 (host.ts:41). 백엔드가 tolerate. saved-host 기능이 이 accidental compatibility 위에 ride 중.

**Why**: Codex finding (2026-04-29). 깨끗한 contract 아님. 누가 한 군데를 fix하면 saved-host 기능이 silent break.

**Pros**:
- 명시적 contract: face-only는 'face-ref' mode + faceRefPath. style-only는 'style-ref' + styleRefPath. backend도 이걸 enforce.
- saved-host의 face_ref-locked 흐름이 안전.

**Cons**:
- Frontend mapper + backend 양쪽 변경.

**Context**: api-mappers.ts:61 lines + host.ts:41 + backend host generation router. 별도 PR로 cleanup.

**Effort**: human ~4시간 / CC ~30분.

**Priority**: P2 (saved-host PR3 ship 후 follow-up).

**Depends on / blocked by**: 없음 (병렬 작업 가능).
