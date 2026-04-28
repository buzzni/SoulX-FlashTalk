# Results Page Overhaul Plan

**Status:** draft for `/plan-eng-review`
**Owner:** jack-buzzni
**Date:** 2026-04-28

---

## 1. Context

`/results` is the user's video library — currently a flat grid of cards that
hides anything not `status: "completed"`. Users have asked for:

- Visibility into **failed** and **cancelled** renders (today they vanish silently)
- **Status filtering** (all / 완료 / 실패 / 취소)
- **Sorting** (latest / name)
- **Pagination** (page numbers — user explicitly chose this over infinite scroll)
- Better **video titles** — current `videoTitle()` truncates the user's prompt
  text or falls back to filename basenames, both of which read poorly

The current title strategy (`frontend/src/lib/format.ts:19-46`) is:

1. `script_text` (user's wizard prompt) → 60-char truncate
2. `host_image` filename basename (strip ext + leading timestamp)
3. `영상 #ABC123` (task_id slice 0..6)

Other surfaces (`RenderDashboard`, `ResultPage`, `QueueStatus`) already use a
canonical format from `frontend/src/studio/taskFormat.js`:
**`내 쇼호스트 영상 #ABCD`** (or `내 멀티 대화 #ABCD` for `type: conversation`).
The library page is the only surface drifting.

## 2. Locked decisions

| # | decision | answer |
|---|----------|--------|
| 1 | Phase 1 title strategy | Use canonical `formatTaskTitle(task_id, type)` from `taskFormat.js` everywhere. Drop `script_text`/filename-derived titles. |
| 2 | Phase 2 title strategy | User-editable name. UI: rename in result page header + on grid card hover menu. Storage: new `display_name` field on `studio_results`. Phase 2 ships in a follow-up PR after Phase 1 lands. |
| 3 | Listing pagination | Page-based (`?offset=N&limit=24`). Page numbers in UI footer. Not infinite scroll. |
| 4 | Page size | 24 cards per page (4×6 desktop grid feels balanced). |
| 5 | Status filter values | `all` (default) / `completed` / `error` / `cancelled`. `running` excluded — that's the queue's job, not the library's. |
| 6 | Default sort | `latest` (by `completed_at DESC`, falling back to `created_at DESC` for non-completed). |
| 7 | Name sort field | Sort by the same string that the UI displays (Phase 1: derived from `(type, task_id)`; Phase 2: `display_name` if present, else derived). Computed via repo-level projection so MongoDB sort is stable. |
| 8 | Failed/cancelled card UX | Same grid layout. Status pill replaces "완료" pill. Click takes you to `/result/:taskId` (which already handles non-completed states). Hover-preview disabled (no playable video). Thumbnail dimmed. |
| 9 | Status badges | `완료` (green / pill-success), `실패` (red / pill-destructive), `취소됨` (muted / pill-muted). Reuse existing `pill-*` classes in `app.css`. |
| 10 | Empty state per filter | `완료` with 0 results → "아직 완성된 영상이 없어요". `실패` 0 → "실패한 영상이 없어요". `취소` 0 → "취소된 영상이 없어요". |
| 11 | Backend filter combination | Status + playlist + sort all combine. Cursor-aware count returned for pagination. |
| 12 | Backend behavior on stale page (e.g., page 5 but only 3 pages exist after a deletion) | Return `200` with empty `videos[]` and `total` set correctly. Frontend snaps to last valid page if its current page is now out of range. |
| 13 | URL state | Filter / sort / page reflected in query string (`?status=&sort=&page=&playlist_id=`). Browser back-button navigates between filter states. |
| 14 | Counts endpoint | **Separate `/api/history/counts`** lightweight endpoint (1 aggregate query). Recomputed per request — counts change with every task lifecycle event + playlist move, so caching is not viable without ETag invalidation hooks (deferred). Eng-review D1A; Codex T-codex#9 refinement. |
| 15 | Name sort | ~~Precompute display_title + index.~~ **Phase 1: `latest` sort only — no sort UI, no display_title field, no name-sort index.** Codex T2 reversal of D2A: canonical title is "내 쇼호스트 영상 #ABCD" with random hex suffix; sorting by it is sorting by hex randomness, fake-value work for Phase 1. Phase 2's `display_name` ships sort dropdown + name sort + display_title field + index together (one coherent slice). |
| 16 | Pagination component | **Extract** to `frontend/src/components/pagination.tsx` (not inline). Reused by future surfaces (HomePage, MyPage). Eng-review D3C. |
| 17 | Status pill utilities | Add `pill-error` (uses `--destructive-soft`) and `pill-muted` (alias of `pill-neutral` semantically, kept distinct for naming clarity) to `index.css`. Existing `pill-amber` reserved for warning/in-progress states. Eng-review D4C. |
| 18 | Test coverage | **Full coverage** — both regressions + all happy/edge paths + lifecycle integration tests + error-mapping unit tests in PR1+PR2. Boil the lake. Eng-review D5T + Codex T-codex#8 lifecycle additions. |
| 19 | Latest sort index | Add `{user_id:1, completed_at:-1}` so `find({user_id, status: {$in: [...]}})` sort by `completed_at` is index-served. **All terminal rows (completed/error/cancelled) MUST set `completed_at` at write time** (Codex T-codex#5) so the single sort key works without coalesce; failed-fast errors before the worker starts running set `completed_at = created_at`. Eng-review D6P. |
| 20 | Failed/cancelled persistence (Codex T1, BLOCKING) | **PR1 includes a write-path change: `studio_results.upsert()` now fires on error/cancelled too, not just success.** New `_persist_terminal_failure(task_id, user_id, type, params, status, error_message, playlist_id)` helper called from `app.py` exception handler ([currently `set_task_error()` at line 855]) and from `task_queue.cancel_task` ([line 118]). One-shot backfill script reads existing `task_queue.json` rows with `status in ("error","cancelled")` and writes `studio_results` rows. Without this, status filter chips return empty grids — the entire feature is meaningless. |
| 21 | Playlist count semantics (Codex T3) | `studio_playlist_repo.video_count` changes meaning: count **all terminal rows in playlist** (not completed-only). Ensures playlist chip count == sum of status chip counts when scoped. Reseed counts in same backfill script as #20. Migration safe — counts only grow, never lose values. |
| 22 | Error sanitization (Codex T4) | New `public_error` field on `studio_results` rows. Server-side mapping table at write time maps known patterns (CUDA OOM, file-not-found, length errors) to Korean user-friendly messages; unknown errors fall through to "알 수 없는 이유로 실패했어요". Raw `error` field kept for admin endpoint only. `/api/history` returns `public_error`; `/result/:id` returns both for the error display flow. |

## 3. Backend changes

### 3.1 Repo: `modules/repositories/studio_result_repo.py`

Replace `list_completed()` with `list_for_user()`:

```python
async def list_for_user(
    user_id: str,
    *,
    statuses: list[str] | None = None,        # default: ["completed", "error", "cancelled"]
    playlist_id: Optional[str] = None,
    offset: int = 0,
    limit: int = 24,
) -> tuple[list[dict], int]:                  # (rows, total_matching)
    """Return paginated manifests for `user_id`, sorted latest-first.

    Sort (decision #19): completed_at DESC, then task_id ASC (tiebreak).
    Served by {user_id:1, completed_at:-1}. All terminal rows MUST have
    completed_at set — see _persist_terminal_failure below for the failure path.

    No name sort in Phase 1 (decision #15).
    """
```

Counts aggregation (decision #14):

```python
async def counts_for_user(
    user_id: str,
    *,
    playlist_id: Optional[str] = None,
) -> dict[str, int]:
    """Return {all, completed, error, cancelled} counts. Single aggregate query.
    Recomputed per request — counts change frequently (decision #14)."""
```

### 3.1a Failed/cancelled persistence (decision #20, BLOCKING)

```python
async def _persist_terminal_failure(
    *,
    user_id: str,
    task_id: str,
    type: str,                               # "generate" | "conversation"
    status: str,                             # "error" | "cancelled"
    error: Optional[str],                    # raw error string from worker
    params: Optional[dict],                  # dispatch params snapshot
    playlist_id: Optional[str],
    started_at: Optional[datetime],
    created_at: datetime,
) -> None:
    """Write a studio_results row for a terminal failure or cancellation.

    Called from:
      - app.py exception handler (line ~855) when generate_video_task raises
      - app.py exception handler (line ~2039) for conversation_task
      - task_queue.cancel_task (line ~118) on user-initiated cancel

    All terminal rows guarantee completed_at is set, so the latest sort
    index serves them without a coalesce.
    """
    completed_at = _now()
    public_error = _map_public_error(error) if status == "error" else None
    manifest = {
        "task_id": task_id,
        "type": type,
        "status": status,
        "error": error,                       # raw, admin-only via /api/results/{id}
        "public_error": public_error,         # decision #22, user-facing
        "params": params or {},
        "playlist_id": playlist_id,
        "created_at": created_at,
        "started_at": started_at,
        "completed_at": completed_at,         # always set, satisfies decision #19
        "video_path": None,
        "video_bytes": 0,
    }
    await upsert(user_id, manifest)
```

### 3.1b Public error mapping (decision #22)

```python
# modules/repositories/studio_result_repo.py — module-level table

_ERROR_MAP: list[tuple[re.Pattern, str]] = [
    (re.compile(r"CUDA out of memory|OOM", re.I),
        "서버가 바쁜 상태입니다. 잠시 후 다시 시도해 주세요."),
    (re.compile(r"audio.*not found|audio.*missing", re.I),
        "음성 파일을 찾을 수 없어요. 파일이 삭제됐을 수 있어요."),
    (re.compile(r"audio.*too long|duration.*exceed", re.I),
        "음성 파일이 너무 길어요. 30초 이하로 잘라 주세요."),
    (re.compile(r"image.*not found|host_image.*missing", re.I),
        "쇼호스트 이미지를 찾을 수 없어요."),
    (re.compile(r"output.*not.*generated|output.*missing", re.I),
        "영상 생성에 실패했어요. 다시 시도해 보세요."),
    (re.compile(r"timeout|deadline", re.I),
        "처리 시간이 너무 오래 걸려서 중단됐어요."),
    (re.compile(r"cancelled by user|user.*cancel", re.I),
        "사용자가 취소했어요."),
]

def _map_public_error(raw: Optional[str]) -> str:
    if not raw:
        return "알 수 없는 이유로 실패했어요."
    for pattern, message in _ERROR_MAP:
        if pattern.search(raw):
            return message
    return "알 수 없는 이유로 실패했어요."
```

Unit test coverage: 7+ rows (each pattern + 1 fallback). Add new mappings
when a new failure pattern surfaces in production logs.

### 3.1c Backfill migration

`scripts/backfill_studio_results_failures.py` — one-shot script that:

1. Reads `task_queue.json` (or in-memory `task_queue._queue` post-restart)
   for entries with `status in ("error", "cancelled")` and no
   corresponding `studio_results` row.
2. Writes `studio_results` rows via `_persist_terminal_failure(...)`,
   computing `public_error` for status=error rows.
3. Recomputes `studio_playlist_repo.video_count` for all playlists per
   decision #21 (count all terminal rows now, not just completed).
4. Idempotent (skip if `studio_results` row already exists for that task_id).

Tests (decision #18): partial-input regression cases — task_queue rows
missing user_id (orphans, skip), missing type (default "generate"),
missing created_at (best-effort fallback to `datetime.min`).

### 3.2 Endpoint: `GET /api/history`

Extend with new query params:

| param         | type     | default        | values                                  |
|---------------|----------|----------------|-----------------------------------------|
| `status`      | string   | (all 3)        | `all` \| `completed` \| `error` \| `cancelled` |
| `offset`      | int      | `0`            | ≥ 0                                     |
| `limit`       | int      | `24`           | 1..100                                  |
| `playlist_id` | string   | (none)         | unchanged                               |

`sort` parameter NOT in Phase 1 (decision #15). Phase 2 adds `sort=latest|name`.

Response shape adds:

```jsonc
{
  "total": 173,                  // total matching the filter (NOT just this page)
  "videos": [
    {
      "task_id": "...",
      "type": "generate",        // NEW — enables canonical title
      "status": "completed",     // NEW — enables status badge
      "public_error": null,      // NEW (decision #22) — Korean user-facing, populated when status=error
      "timestamp": "...",
      "script_text": "...",      // kept for backward compat; UI no longer reads it
      "host_image": "...",
      "audio_source": "...",
      "output_path": "...",
      "file_size": 12345678,
      "video_url": "...",
      "generation_time": 12.4
    }
  ]
}
```

### 3.3 Schema: `modules/schemas.py`

Update `VideoHistoryItem` to include `type`, `status`, `public_error`.
Add `Literal` constraints matching `TaskStatus`.

Schema regeneration (Codex T-codex#7): PR1 must regenerate **both**:
1. `frontend/src/api/schemas-generated.ts` (Zod runtime schemas — used by `fetchJSON({schema: ...})`)
2. OpenAPI typescript types (compile-time)

CI gate: PR fails if generated artifacts drift from `modules/schemas.py`.
Add `pnpm gen:schemas && git diff --exit-code` to PR1's CI workflow.

### 3.4 Indexes

Existing index `{user_id:1, status:1, completed_at:-1}` continues to serve
single-status + latest queries.

**New (per decision #19):**
- `{user_id:1, completed_at:-1}` — serves "all-status + latest" sort (`status: {$in: [...]}`)
  without bucket merge.

Phase 2 (deferred per decision #15) will add `{user_id:1, display_title:1}` for name sort.

Added to `modules/db.py::init_indexes`. Existing index kept.

## 4. Frontend changes

### 4.1 `frontend/src/lib/format.ts`

Replace `videoTitle()` body — switch to `formatTaskTitle(task_id, type)` from
`frontend/src/studio/taskFormat.js`. Drop the `script_text` / `host_image`
fallbacks. Keep the function signature stable so existing callers don't break.

```ts
import { formatTaskTitle } from '../studio/taskFormat';

export function videoTitle(item: {
  task_id?: string | null;
  type?: 'generate' | 'conversation' | null;
}): string {
  return formatTaskTitle(item.task_id ?? '', item.type ?? 'generate');
}
```

Phase 2 will add `display_name` precedence in front of the canonical fallback.

### 4.2 `frontend/src/routes/ResultsListPage.tsx`

New UI elements:

- **Status filter chips** — sit on a second row beneath the playlist chip strip.
  Same `FilterChip` component, 4 chips: 전체 / 완료 / 실패 / 취소. Counts come
  from a small grouped-aggregation endpoint (cheap; runs on every page load):
  `GET /api/history/counts?playlist_id=...` returns `{ all, completed, error, cancelled }`.
- ~~**Sort dropdown**~~ — removed from Phase 1 (decision #15). Phase 2 adds it
  alongside user-editable display names.
- **Pagination footer** — beneath the grid. Reuses new `<Pagination>` component
  (decision #16) at `frontend/src/components/pagination.tsx`. Numeric pages with
  ellipsis (`1 … 4 5 6 … 12`) plus prev/next arrows. Disabled state at boundaries.
  Keyboard nav (`←`/`→` when focused). Page count = `ceil(total / 24)`.
- **`ResultCard` non-completed variants** — status pill swaps based on `item.status`.
  Hover-preview / play overlay only for `completed`. `error` shows an inline error
  message snippet from `item.error` below the title (truncated to 80 chars).
  `cancelled` shows "취소됨" pill, no extra messaging.
  - Pill mapping (decision #17): `completed` → `pill-success "완료"`,
    `error` → `pill-error "실패"`, `cancelled` → `pill-muted "취소됨"`.
  - New utilities `pill-error` and `pill-muted` added to `index.css`.

State management:

- Add `status`, `sort`, `page` to URL search params via `useSearchParams`.
- Single `useEffect` loads `/api/history` whenever any filter changes.
- Counts fetched via separate effect, refreshed on filter changes (cheap aggregate).

### 4.3 Empty states

Reuse `EmptyState` component. Title and description differ per filter — driven
by a small switch on `(filter, status)`.

## 5. PR breakdown

**PR1 — backend extension + persistence write path** (≈ 500 lines of Python + tests)
- Add `_persist_terminal_failure()` helper + wire into `app.py` exception handlers
  (generate_video_task, conversation_task) and `task_queue.cancel_task` (decision #20)
- Add error mapping table `_ERROR_MAP` + `_map_public_error()` (decision #22)
- Add `list_for_user()`; deprecate `list_completed()` to a wrapper
- Add `counts_for_user()` aggregation
- Add `scripts/backfill_studio_results_failures.py` (decision #20 + #21):
  reads task_queue rows → writes studio_results rows → reseeds playlist counts
- Extend `/api/history` with `status`/`offset`/`limit` query params
- Add `/api/history/counts` endpoint
- Update `VideoHistoryItem` schema (add `type`, `status`, `public_error`)
- Update `studio_playlist_repo.video_count` to count all terminal rows (decision #21)
- Add `{user_id:1, completed_at:-1}` index
- Regenerate both Zod schemas + OpenAPI types (Codex T-codex#7); PR fails if drift
- Tests:
  - Repo: list_for_user latest sort, status combinations (single/multi/all),
    playlist + status combo, beyond-last-page, empty result, counts sum invariant
  - Persistence write path: generate_video_task error → studio_results row exists
    with public_error mapped + completed_at set; cancelled task → row exists;
    queue prune doesn't break /result/:id (Codex T-codex#8 lifecycle)
  - Backfill: existing task_queue.json with N error rows → N rows in studio_results +
    playlist counts reseeded; idempotent on re-run; orphan rows skipped
  - Error mapping: 7+ patterns + fallback (decision #22)
  - Regression: playlist_id filter still works (CRITICAL); display_title field
    intentionally NOT created (decision #15 reversal of D2A)

**PR2 — frontend overhaul** (≈ 450 lines TS/TSX + minor CSS)
- Replace `videoTitle()` with `formatTaskTitle(task_id, type)` delegation —
  update all 3 callers (`HomePage.tsx:282`, `ResultPage.tsx:693`,
  `ResultsListPage.tsx:542`) to pass `type`
- New `frontend/src/components/pagination.tsx` (page numbers + ellipsis +
  prev/next + keyboard nav, mobile compact variant)
- Add `pill-error` + `pill-muted` utilities to `index.css`
- Status filter chips + pagination footer + URL state (no sort dropdown — decision #15)
- `ResultCard` status variants (pill, no-hover-play, public_error tooltip,
  retry in [⋯] menu) per §13.4
- Skeleton loading state per §13.5
- Tests:
  - videoTitle for generate/conversation/missing-type
  - filter switch resets page=1, pagination prev/next + jump-to-page
  - URL state restoration on reload (`?status=error&page=3` deep-link)
  - failed card click → /result/:id (no auto-play)
  - card variants render correct pill; tooltip shows `public_error` text
  - Pagination boundary disable + keyboard nav
  - Skeleton appears within 150ms threshold

**PR3 — Phase 2: user-editable names** (deferred follow-up)
- Add `display_name` field to `studio_results`
- PATCH endpoint `/api/results/{task_id}/name`
- Rename UI on `ResultPage` header + grid card menu
- `videoTitle()` precedence: `display_name` → canonical
- File-name on download uses `display_name` if set

## 6. Edge cases

- **Title collisions on name sort** — many videos share the canonical title
  (`내 쇼호스트 영상 #ABCD` is unique because of `#ABCD`, but `#ABCD` orders by
  hex which is essentially random). Acceptable for Phase 1; Phase 2's
  `display_name` will solve it for users who care.
- **`error` field too long for inline display** — truncate to ~80 chars on the
  card; full error visible on `/result/:taskId`.
- **Sort by name with non-ASCII** — `localeCompare(a, b, 'ko')` on the frontend
  is the established pattern (already used for playlist names). Backend can do
  a simple `$sort` on the projected string; collation differences are minor for
  the canonical format (which is ASCII for the `#ABCD` portion and stable Korean
  prefix).
- **Filter restoration after task deletion / reassignment** — same defensive
  pattern as playlist filter (decision #12 of the playlist plan): unknown
  values fall back to `all`.
- **Counts drift between page load and grid load** — accept eventual consistency.
  Counts query is cheap; if a render completes mid-session, a manual refresh
  picks it up. (Phase 2 candidate: SSE-driven count updates.)
- **URL state from old bookmarks** — `/results?playlist_id=foo` still works.
  Missing `status`/`sort`/`page` params default to `all`/`latest`/`1`.

## 7. Review log

### Eng review (2026-04-28)

| # | Question | Resolution |
|---|----------|------------|
| 1 | `/counts` separate vs piggyback | **Separate** — D1A → decision #14 |
| 2 | Name sort implementation | ~~D2A: precompute~~ → **REVERSED by Codex T2** → decision #15 (defer to Phase 2) |
| 3 | Pagination component | **Extract** — D3C → decision #16 |
| 4 | Status pill utilities | **pill-error + pill-muted** — D4C → decision #17 |
| 5 | Test coverage | **Full coverage + lifecycle** — D5T → decision #18 |
| 6 | Latest sort index | **`{user_id:1, completed_at:-1}` + completed_at always set** — D6P → decision #19 |

### Design review (2026-04-28)

| # | Question | Resolution |
|---|----------|------------|
| D1 | Filter strip layout | **2-row stack: playlist row, status+sort row** — §13.2 |
| D2 | Loading state | **Skeleton card grid (.skeleton-shimmer)** — §13.5 |
| D3 | Failed card UX | **1-line + tooltip + retry in menu** — §13.4 |
| D4 | Mobile responsive | **Horizontal-scroll snap-x chips, own-row sort, compact pagination** — §13.2 |

### Codex outside voice (2026-04-28)

| # | Question | Resolution |
|---|----------|------------|
| T1 | Failed/cancelled persistence gap | **PR1에 포함 — write path + backfill** → decision #20 (CRITICAL, plan-blocking issue) |
| T2 | Phase 1 name sort fake value | **D2A 철회 — sort UI 제거, Phase 2로** → decision #15 reversal |
| T3 | Playlist count semantics | **all terminal rows로 변경 + reseed** → decision #21 |
| T4 | Error sanitization spec | **public_error 필드 + Korean mapping table** → decision #22 |

Direct adopts (no taste decision needed): Codex T-codex#5 → decision #19 refined,
T-codex#7 → §3.3 schema regen explicit (Zod + OpenAPI both), T-codex#8 → PR1 tests
add lifecycle integration, T-codex#9 → decision #14 acknowledges no caching.

## 8. Out of scope (NOT in scope)

| Item | Why deferred |
|------|--------------|
| Bulk actions (multi-select + delete / move-to-playlist) | Adds significant UI complexity (selection mode, confirm modals). User flow doesn't require it for v1. Revisit after pagination usage data. |
| Search / full-text filtering | Pagination + status filter covers the immediate "find something" need. Full-text needs Mongo text index + UX (search box, debouncing, highlighting). |
| Export / download-all | Heavy backend work (zip streaming, signed URLs). Single-video download already works. |
| Trash / soft-delete with recovery | Schema migration + 30-day cleanup job + UI for recovery. Deletion is rare in current usage. |
| Phase 2 user-editable names | Decision #2 — strictly deferred to PR3. Backend already structured (`display_name` field optional in `display_title` computation) so the swap is local. |
| SSE-driven live counts | "Counts drift between page load and grid load" edge case in §6. Acceptable eventual consistency for v1; manual refresh works. |

## 9. What already exists (reuse, don't rebuild)

| Existing | Reused as | File |
|----------|-----------|------|
| `formatTaskTitle(taskId, type)` | Phase 1 title source | `frontend/src/studio/taskFormat.js:22` |
| `EmptyState` component | Per-filter empty states | `frontend/src/components/empty-state.tsx` |
| `Spinner` component | Loading states | `frontend/src/components/spinner.tsx` |
| `DropdownMenu` (shadcn) | Sort dropdown | `frontend/src/components/ui/dropdown-menu.tsx` |
| `FilterChip` (in-file pattern) | Status filter chips | `frontend/src/routes/ResultsListPage.tsx:350-368` |
| `useSearchParams` (React Router) | URL state for filter/sort/page | built-in |
| `pill-success`, `pill-neutral` | Existing pill utilities | `frontend/src/index.css:511,541` |
| `--destructive-soft` color token | `pill-error` background | `frontend/src/index.css:137+` |
| `studio_result_repo.upsert()` | Hook point for `display_title` write | `modules/repositories/studio_result_repo.py:49` |

## 10. Failure modes

| Codepath | Realistic failure | Test? | Error handling? | User sees? |
|----------|------------------|-------|-----------------|------------|
| `list_for_user` name sort | `display_title` field missing on legacy row | ✅ backfill regression test (CRITICAL) | $ifNull → `_compute_display_title` fallback in aggregation | Sorted correctly post-backfill |
| `list_for_user` pagination | `offset > total` after deletion in another tab | ✅ beyond-last-page test | Returns `200` with empty `videos[]`, real `total`. Frontend snaps to last valid page | Empty grid → auto-redirect to last page |
| `/api/history/counts` | Aggregation timeout on slow user (10k+ renders) | ✅ counts integrity test | 15s timeout, returns 408 with retryable error | "통계를 못 불러왔어요" with retry button |
| `videoTitle({type: undefined})` | Backend response missing `type` field | ✅ default-type test | Defaults to `'generate'` | Reads "내 쇼호스트 영상 #ABCD" (acceptable) |
| `<Pagination>` | Total = 0 (empty filter result) | ✅ Pagination boundary test | Component renders nothing | No footer, just empty state |
| Status filter URL deep-link | `?status=invalid_value` | ✅ URL state restoration test | Frontend defaults to `all` | Correct restoration |
| ResultCard `error` variant | `error` field is null but status="error" | ✅ card variants test | Skip error message render, keep pill | Just sees 실패 pill, no message |

**CRITICAL gaps:** None. All failure modes have tests + error handling + visible user feedback.

## 11. Worktree parallelization

| Step | Modules touched | Depends on |
|------|----------------|------------|
| Backfill migration script | `scripts/`, `modules/repositories/` | — |
| `list_for_user` + `counts_for_user` + indexes | `modules/repositories/`, `modules/db.py` | — |
| `/api/history` + `/api/history/counts` endpoints | `app.py`, `modules/schemas.py` | repo work above (same lane) |
| Pagination component + pill utilities | `frontend/src/components/`, `frontend/src/index.css` | — |
| `videoTitle` + 3 caller updates | `frontend/src/lib/`, `frontend/src/{routes,studio}/` | — |
| ResultsListPage overhaul | `frontend/src/routes/ResultsListPage.tsx` | Pagination component, schema regen |

**Lanes:**
- **Lane A (sequential, backend):** Backfill script → repo extension → endpoint → schema regen
- **Lane B (independent, frontend infra):** Pagination component + pill utilities
- **Lane C (independent, frontend logic):** `videoTitle` delegation + 3 caller updates

**Execution order:**
1. Launch A + B + C in parallel worktrees
2. Merge B and C first (no shared modules)
3. Merge A
4. Then ResultsListPage overhaul (depends on all three)

**Conflict flags:** Lane A and the eventual ResultsListPage overhaul both need
the regenerated `schemas-generated.ts` — sequence the schema regen step explicitly
so frontend doesn't lag.

## 13. Design specifications (added by `/plan-design-review` 2026-04-28)

### 13.1 Component sourcing matrix (Tailwind + existing + shadcn fallback)

| New surface | Source | File |
|-------------|--------|------|
| Status filter chips | Reuse `FilterChip` (in-file) | `frontend/src/routes/ResultsListPage.tsx:350-368` |
| Sort dropdown | Reuse `DropdownMenu` (shadcn) | `frontend/src/components/ui/dropdown-menu.tsx` |
| Pagination footer | shadcn pattern (no existing) | NEW `frontend/src/components/pagination.tsx` |
| `pill-error` / `pill-muted` | Tailwind `@utility` (no existing) | NEW in `frontend/src/index.css` |
| Skeleton loading | Reuse `.skeleton-shimmer` | existing in `frontend/src/studio/styles/app.css:37` |
| Tooltip (error detail) | Reuse `Tooltip` (shadcn) | `frontend/src/components/ui/tooltip.tsx` |

**Zero new dependencies.** All Tailwind utilities + existing components + one shadcn-pattern component.

### 13.2 Layout structure (D1)

Desktop (≥ 768px):

```
┌─ AppLayout sidebar ────┬─ /results main ──────────────────────────────────────┐
│ [logo] 스튜디오        │ 라이브러리                                            │
│ [+] 새 영상 만들기     │ # 내 영상들                                           │
│ ─ 작업 ─               │ 173개의 영상                                          │
│   홈                   │                                                       │
│   내 영상들 ●          │ ┌─ Row 1: playlist chips (existing) ─────────────────┐│
│ ─                      │ │ [전체 173] [미지정 12] | [신상품 23] [···]         ││
│   내 정보              │ └────────────────────────────────────────────────────┘│
│   도움말               │ ┌─ Row 2: status chips + sort dropdown ──────────────┐│
└────────────────────────│ │ [전체 173] [완료 156] [실패 14] [취소 3]    [↓ 최신순]│
                         │ └────────────────────────────────────────────────────┘│
                         │ ┌─ grid-cols-[repeat(auto-fill,minmax(240px,1fr))] ──┐│
                         │ │ [card] [card] [card] [card] [card]                 ││
                         │ │ [card] [card] [card] [card] [card]                 ││
                         │ │     ... (24개 페이지)                              ││
                         │ └────────────────────────────────────────────────────┘│
                         │       ┌─ Pagination footer ─────────────────┐         │
                         │       │ ◀ 1 … 4 [5] 6 … 12 ▶                │         │
                         │       └─────────────────────────────────────┘         │
                         └──────────────────────────────────────────────────────┘
```

Mobile (≤ 640px) — D4:

```
┌─ /results ───────────────────────┐
│ ☰ 라이브러리                     │
│ # 내 영상들 (173개)              │
│ ┌─ overflow-x-auto, snap-x ────┐ │
│ │ [전체] [미지정] | [신상품] →│ │  ← Row 1 horizontal scroll, fade edges
│ └──────────────────────────────┘ │
│ ┌──────────────────────────────┐ │
│ │ [전체] [완료] [실패] [취소] →│ │  ← Row 2 horizontal scroll
│ └──────────────────────────────┘ │
│ ┌──────────────────────────────┐ │
│ │ [↓ 최신순             ] full │ │  ← Sort owns own row, w-full button
│ └──────────────────────────────┘ │
│ ┌─ grid (2 cols on mobile) ───┐  │
│ │ [card] [card]               │  │
│ │ [card] [card]               │  │
│ └─────────────────────────────┘  │
│      ◀ 5 / 12 ▶                  │  ← compact pagination
└──────────────────────────────────┘
```

### 13.3 Interaction states

| State | Visual | Source |
|-------|--------|--------|
| Loading (initial / page change / filter change) | **Skeleton card grid** — 8 placeholder cards using `.skeleton-shimmer` utility, same dimensions as real cards. NO layout shift. | D2 |
| Error (grid fetch fail) | Centered card with destructive-soft background + retry button. Same surface-card class. | NEW |
| Error (counts fetch fail) | Counts pills show "—" instead of number. Filter still functional. | NEW |
| Empty (`status=all`, 0 videos) | EmptyState (existing) — "아직 만든 영상이 없어요" + "첫 영상 만들러 가기 →" CTA | existing |
| Empty (`status=error`, 0) | EmptyState — "실패한 영상이 없어요 🎉" (subtle positivity, no CTA) | NEW |
| Empty (`status=cancelled`, 0) | EmptyState — "취소한 영상이 없어요" (no CTA) | NEW |
| Empty (playlist with 0 items) | existing "이 플레이리스트는 비어있어요" | unchanged |
| Beyond-last-page | Auto-redirect to last valid page (no broken empty grid) | §10 failure mode |

### 13.4 Failed card UX (D3)

```
┌────────────────────────────────────┐
│ ┌──────────────────────────────┐   │
│ │ [dimmed thumbnail]      [⋯] │   │
│ │ [🔴 실패]                    │   │  ← pill-error top-left
│ └──────────────────────────────┘   │
│ 내 쇼호스트 영상 #ABCD              │  ← canonical title (D2A)
│ 04.28 · 12:34                       │
│ ⚠ 음성 파일이 너무 길어요 (ⓘ)       │  ← 1-line truncated error + tooltip
└────────────────────────────────────┘
```

- **Error message:** 1-line truncate at ~32 chars in card. Hover/focus on `(ⓘ)` opens shadcn `<Tooltip>` with full message (max 240 chars, server-side sanitized — no file path leakage).
- **Retry CTA:** lives in the `[⋯]` dropdown menu (top-right) labeled "다시 만들기" — same menu where playlist-move and delete live. Mirrors ResultPage's existing "수정해서 다시 만들기" button (commit `549cd0d`) for consistency.
- **Click behavior:** card click → `/result/:taskId` (existing route already handles error state with full diagnostics).
- **Cancelled variant:** `pill-muted "취소됨"`, no error message line, no retry CTA.

### 13.5 Loading states (D2 detail)

- **Initial load:** 8 skeleton cards with `.skeleton-shimmer` (existing utility). Replaces prior `Spinner` "불러오는 중" pattern.
- **Filter / sort change:** Same skeleton grid replaces current grid. Counts pills also show shimmer until both `/api/history` and `/api/history/counts` resolve.
- **Page navigation:** Skeleton grid for ~150ms minimum (debounce flash) — if response is faster, skip skeleton entirely.

### 13.6 Pagination component spec

```
Desktop:  ◀ 1 … 4 [5] 6 … 12 ▶          (numeric pages with ellipsis)
Mobile:   ◀ 5 / 12 ▶                     (compact, current/total)
```

- Sibling boundary: `[current-1, current, current+1]` always visible
- Edge boundary: first and last page always visible if not adjacent
- Disabled state at boundaries (page 1 → ◀ disabled, gray)
- Keyboard: `←` / `→` when component focused; `Home` / `End` jump to first/last
- a11y: `<nav role="navigation" aria-label="페이지 이동">`, current page `aria-current="page"`
- Width: full-bleed `flex justify-center mt-8`. No surface-card wrapper.

### 13.7 Pill specifications (utility additions)

Add to `frontend/src/index.css` after existing pill utilities (line 549):

```css
@utility pill-error {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px;
  background: var(--destructive-soft);
  color: var(--destructive-on-soft);
  border-radius: 99px;
  font-size: 11px; font-weight: 600;
  letter-spacing: -0.005em;
}

@utility pill-muted {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px;
  background: var(--surface-2);
  color: var(--ink-3);                  /* dimmer than pill-neutral's --ink-2 */
  border-radius: 99px;
  font-size: 11px; font-weight: 600;
  letter-spacing: -0.005em;
}
```

Verify `--destructive-soft` and `--destructive-on-soft` tokens exist in `:root`. If not, fall back to `--destructive` with `15%` alpha overlay.

### 13.8 Accessibility checklist

- [ ] All chips: `<button type="button">`, focus ring, `aria-pressed={active}`
- [ ] Sort dropdown: shadcn DropdownMenu already a11y-correct (Radix)
- [ ] Status icons in pills: `aria-hidden`, label text is the source of truth
- [ ] Failed card: full error available via Tooltip with `aria-describedby` linking ⓘ to tooltip content
- [ ] Pagination: `<nav aria-label="페이지 이동">`, page links use `<a>` with `aria-current="page"` for current
- [ ] Touch targets: chips ≥ 32px height (currently 30px — bump 1px), pagination items ≥ 36px
- [ ] Color contrast: pill-error text on destructive-soft must pass WCAG AA (4.5:1) — verify with browser tool after implementation
- [ ] Filter URL state: deep-link `?status=error` is screen-reader announceable via page heading update

### 13.9 Empty states (per filter)

| Filter | Title | Description | Action |
|--------|-------|-------------|--------|
| `all` (no videos at all) | 아직 만든 영상이 없어요 | 첫 영상을 만들어 라이브러리를 채워보세요. | `첫 영상 만들러 가기 →` (link button, primary color) |
| `completed`, 0 of N>0 | 아직 완성된 영상이 없어요 | 진행 중인 작업을 확인해 보세요. | `진행 중 보기 →` (links to render queue) |
| `error`, 0 | 실패한 영상이 없어요 🎉 | 모든 영상이 잘 만들어졌어요. | (no CTA — celebratory) |
| `cancelled`, 0 | 취소한 영상이 없어요 | (no description) | (no CTA) |
| Playlist with 0 | 이 플레이리스트는 비어있어요 | (existing) | (existing) |

Use existing `EmptyState` component. The 🎉 emoji is acceptable here per the user-stated convention (emoji on celebratory empty state, not on routine UI).

### 13.10 Design system gap

DESIGN.md does not exist. This plan reuses tokens correctly but a future
`/design-consultation` would solidify the system before further surfaces are
added. **Recommendation:** Add to TODOS — not blocking PR1/PR2.

## 12. TODOS for follow-up

(Surfaced during eng-review; not in PR1/PR2 scope.)

- **Phase 2 user-editable names** — UI rename + `display_name` field + PATCH endpoint.
  Backend already structured for this (`display_title` computation has the hook).
- **Bulk actions** — multi-select + bulk delete / bulk move-to-playlist. Wait for
  pagination usage signal before building.
- **SSE-driven live counts** — when a render completes mid-session, status counts
  should update without page refresh. Low priority.
- **Search / full-text filter** — Mongo text index on `display_title` + script_text.
  Wait for user request signal.
- **DESIGN.md creation** — Run `/design-consultation` to formalize the design
  system (tokens, components, spacing scale, motion library) into a single
  source of truth. Currently scattered across `index.css`, `app.css`, component
  files. Surfaced by `/plan-design-review` 2026-04-28 §13.10.
- **Mobile filter bottom sheet** — D4 picked horizontal-scroll chips for now.
  If user testing shows discoverability issues on phones, switch to a `Sheet`
  (shadcn) with "필터 열기" button. Adds shadcn Sheet dependency.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (scope already clear from user) |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found→resolved | 9 problems, 4 taste-decisions → 4 plan changes (decisions #20-22 + #15 reversal) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 6 issues, 6 decisions made, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR | score: 6/10 → 9/10, 4 decisions made |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

**CROSS-MODEL:** Codex found **1 plan-blocking gap** (failed/cancelled persistence) that eng-review missed. D2A reversed by Codex T2 (name sort defer). Net: plan strengthened — D2A reversal removes 350 lines of unnecessary backend work; #20 adds ~150 lines of necessary write-path work; #22 adds ~40 lines of error mapping.

**UNRESOLVED:** 0 (all 14 D-questions answered: 6 eng + 4 design + 4 codex tensions)
**VERDICT:** ENG + DESIGN + CODEX CLEARED — ready to implement
