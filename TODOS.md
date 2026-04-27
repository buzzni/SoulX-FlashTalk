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

