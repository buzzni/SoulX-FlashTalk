# Playlist Feature Plan

**Status:** draft for `/plan-eng-review`
**Owner:** jack-buzzni
**Date:** 2026-04-26

---

## 1. Context

Studio users (jack and future operators) want to **bundle generated AI host
videos into named groups** — a "broadcast playlist" mental model
("겨울 컬렉션", "신상품 소개", "11월 라방", etc.). Today every completed render
sits in a flat user-scoped list at `/results`; there's no way to organize.

The user explicitly framed this as **playlist** (not category) because:
- Sequential / "play next" semantics fit (broadcast-style consumption).
- YouTube/Spotify analogy makes the UI metaphor zero-learning.
- "카테고리" implies static taxonomy (product category, board category)
  which isn't what we mean.

## 2. Locked decisions

| # | decision                                                | answer |
|---|---------------------------------------------------------|--------|
| 1 | data model                                              | **1 video = 0 or 1 playlist** (not multi-tag). Single optional `playlist_id` on `studio_results`. |
| 2 | naming                                                  | **playlist** everywhere — collection, field, API, UI. Known expectation gap: v1 builds grouping only; users may assume play-next/ordering. Documented in §10. |
| 3 | optional vs required at generate time                   | **optional**. New videos default to "미지정". |
| 4 | reassignable after generation                           | **yes** — PATCH endpoint. |
| 5 | playlist deletion — what happens to its videos          | **cascade to "미지정"** (set `playlist_id: null`). No videos are deleted. |
| 6 | rename allowed                                          | **yes** — `name` is display, `playlist_id` is the stable reference. |
| 7 | management UI location                                  | inline on `/results` (sidebar list + per-card "[⋯] move to" menu). Sidebar rename/delete IS in v1; only "edit assignment from /result/:taskId" is deferred. No standalone `/playlists` page in v1. |
| 8 | scope for this PR                                       | **phase 1 only**: backend + filter + assign-during-generate + reassign-from-card + sidebar rename/delete. Edit-assignment-from-result-page and reordering deferred. |
| 9 | playlist_id validation                                  | Single source of truth: `studio_playlist_repo.exists(user_id, playlist_id) → bool`. Called from set_playlist, manifest upsert, history filter, delete cascade. PATCH path raises `404` on miss; manifest upsert path silently coerces to `null`. |
| 10 | name normalization                                     | Store raw `name`. Maintain `name_normalized` field = `unicodedata.normalize('NFC', name).strip().casefold()`. Unique index lives on `(user_id, name_normalized)`. Reserved names ("미지정", "unassigned") checked against the same normalized form. |
| 11 | sidebar order                                           | Application-level alphabetical sort on `name`. Drop `{user_id, created_at:-1}` from indexes — the per-user list is small enough that an in-memory sort is fine. |
| 12 | unknown / deleted `playlist_id` in history filter       | `GET /api/history?playlist_id=<deleted_id>` returns `200` with `[]`. Returning `404` would break filter-UI restoration when a playlist gets deleted in another tab. |
| 13 | Step 3 playlist fetch failure                           | Graceful degradation. Show "플레이리스트 목록을 못 불러왔어요 — 이번 영상은 미지정으로 저장됩니다" + retry button. Render is never blocked. |

## 3. Schema

### New collection: `studio_playlists`

```jsonc
{
  _id, user_id,
  playlist_id,                  // 32-char hex uuid; stable reference
  name,                         // user-facing label, can change
  created_at, updated_at,
}
```

Indexes (added in `modules/db.py::init_indexes`):
- `{user_id:1, playlist_id:1}` unique
- `{user_id:1, name_normalized:1}` unique — see decision #10 (NFC + casefold + strip)

(No `created_at` index — sidebar listing is small per user, sorted in-app.)

### `studio_results` — additive field

```diff
{
   _id, user_id, task_id,
   ...,
+  playlist_id,                  // null | <playlist_id>; default null = 미지정
}
```

New index: `{user_id:1, playlist_id:1, completed_at:-1}` for filtered history.

No migration needed — absent field = `null` = 미지정. Existing 4 imported
manifests stay in 미지정 until the user moves them.

## 4. API surface

All endpoints owner-scoped via the existing `auth_middleware`.

| method | path                                  | purpose |
|--------|---------------------------------------|---------|
| GET    | `/api/playlists`                      | list user's playlists with video counts (incl. synthetic "미지정"). Single aggregation `$group by playlist_id` — no N+1. |
| POST   | `/api/playlists`                      | create. body: `{name}` |
| PATCH  | `/api/playlists/{playlist_id}`        | rename. body: `{name}` |
| DELETE | `/api/playlists/{playlist_id}`        | delete; cascade to "미지정" |
| PATCH  | `/api/results/{task_id}/playlist`     | move/unmove. body: `{playlist_id: <id> \| null}`. Validates `exists(user_id, playlist_id)` → 404 on miss/cross-user. |
| GET    | `/api/history?playlist_id=<id>`       | filter. `id="unassigned"` = videos with `playlist_id: null`. Unknown / deleted id returns `200 []`. |
| POST   | `/api/generate`                       | (existing) — accept optional `playlist_id` Form param. |
| POST   | `/api/generate-conversation`          | (existing) — also accepts optional `playlist_id`. |

Response shape for `GET /api/playlists`:
```jsonc
{
  "playlists": [
    {"playlist_id": "...", "name": "...", "video_count": N, "created_at": "..."},
    ...
  ],
  "unassigned_count": M
}
```

Errors:
- `POST /api/playlists` with duplicate name → `409 Conflict`
- `PATCH` rename to existing name → `409`
- `DELETE` non-existent → `404`
- `PATCH /api/results/.../playlist` with unknown `playlist_id` → `404`
  (caller must create first or pass `null`)

## 5. Repository — `modules/repositories/studio_playlist_repo.py`

```python
async def create(user_id, *, name) -> dict                       # raises if normalized-name dup
                                                                  # rejects reserved (미지정/unassigned)
async def exists(user_id, playlist_id) -> bool                   # SOLE ownership check (decision #9)
async def list_for_user(user_id) -> list[dict]                    # with video_count via $group aggregation
async def get(user_id, playlist_id) -> Optional[dict]
async def rename(user_id, playlist_id, *, name) -> Optional[dict] # raises on normalized-name dup
async def delete(user_id, playlist_id) -> bool                    # cascades videos to null first, then drops row
async def count_for_user(user_id) -> int
async def unassigned_count(user_id) -> int                        # studio_results where playlist_id null
```

`studio_result_repo` extensions:
```python
async def upsert(user_id, manifest)                                # EXTEND: validate playlist_id via
                                                                    # studio_playlist_repo.exists; coerce to
                                                                    # null silently if missing/cross-user
async def set_playlist(user_id, task_id, playlist_id_or_none)      # raises LookupError on bad target
                                                                    # → app.py surfaces as 404
async def clear_playlist_id(user_id, playlist_id) -> int           # bulk for cascade
async def list_completed(user_id, *, limit,
                          playlist_id=None|"unassigned"|<id>)      # filter; "unassigned" matches null+missing
```

The cascade-to-null happens inside `studio_playlist_repo.delete()`:
```python
await result_repo.clear_playlist_id(user_id, playlist_id)
await playlist_coll.delete_one({user_id, playlist_id})
```
Best-effort ordering: clear first, then drop the playlist row. If the
clear succeeds and the delete fails, a re-run of `delete()` is a no-op
on already-cleared rows and removes the orphan playlist row.

## 6. UI

### Generation flow (Step 3 → final dispatch)

Add a single playlist select in `routes/StepPages.tsx` Step 3 footer (or
the dispatch screen — TBD during impl):

```
┌──────────────────────────────────────────┐
│ 플레이리스트:  [미지정 ▾]                  │
│              ├─ 미지정                    │
│              ├─ 겨울 컬렉션                 │
│              ├─ 신상품                    │
│              ├─ ──────                    │
│              └─ + 새 플레이리스트 만들기      │
└──────────────────────────────────────────┘
```

Selection POSTed alongside `/api/generate` as `playlist_id` form param.
Inline-create flow: small modal `{ name }` → POST `/api/playlists` →
auto-select the newly returned id.

`app.py /api/generate` change: optional `playlist_id` Form param; when
the worker writes the result manifest, it passes `playlist_id` through
to `studio_result_repo.upsert`.

### `/results` page

Two-pane layout:

```
┌────────────────────┬────────────────────────────────┐
│ 플레이리스트         │ 카드 그리드                      │
│ ─────────────────  │                                │
│ 전체 (24)          │  [card] [card] [card]          │
│ 미지정 (3)         │  [card] [card] [card]          │
│ ─────              │                                │
│ 겨울 컬렉션 (10)    │  ...                           │
│ 신상품 (8)          │                                │
│ + 새 플레이리스트    │                                │
└────────────────────┴────────────────────────────────┘
```

Card right-corner [⋯] opens a menu: "다른 플레이리스트로 이동" → small
popover with the same list. Selection → PATCH
`/api/results/{task_id}/playlist`.

Sidebar item right-click / hover [⋯] → 이름 변경 / 삭제 inline.

## 7. Phasing

**This PR (phase 1):**
- studio_playlists collection + repo + tests
- studio_results.playlist_id field + result_repo extensions
- 6 endpoints
- /api/generate accepts playlist_id form param
- /results sidebar (list + filter + count) + card [⋯] move menu
- Step 3 generation flow: playlist selector + inline-create modal

**Deferred (later PRs):**
- Edit playlist on `/result/:taskId` page
- Reordering videos within a playlist (`position` field)
- "Play next" auto-advance on `/result/:taskId`
- Public share URL `/p/<playlist_id>`
- Bulk operations (move N videos at once)
- Drag-and-drop reorganize between playlists

## 8. Tests

New:
- `tests/test_studio_playlist_repo.py` — CRUD, user scoping, name dup,
  cascade-to-null on delete, count helpers
- `tests/test_api_playlists.py` — 6 endpoints happy + sad (404/409),
  user_id isolation across two test users, generate-with-playlist_id flow

Extensions:
- `tests/test_studio_result_repo.py` — `set_playlist`,
  `clear_playlist_id`, `list_completed(playlist_id=...)` filter,
  `playlist_id="unassigned"` special case

No frontend tests (consistent with the rest of the SPA's test posture —
visual logic, manually verified in browser).

## 9. NOT in scope

| item                                | reason                                      |
|-------------------------------------|---------------------------------------------|
| Multiple playlists per video (tags) | Decision #1 — single membership only        |
| Playlist ordering (`position`)      | Default `completed_at desc` is fine for v1  |
| Public share URLs                   | Internal-only product today                 |
| Bulk operations                     | Per-card "move" covers 95% of use; bulk is a P2 |
| Standalone `/playlists` page        | Sidebar-on-/results is simpler for v1; promote later if scope grows |
| Migrating existing 4 results        | They land in "미지정" naturally; user moves them via UI |
| Cross-user shared playlists         | Decision #1 — per-user                      |

## 10. Risks / open questions

1. **`playlist_id` index cardinality** — most studios will have 5-20
   playlists. The compound index `{user_id, playlist_id, completed_at}`
   stays small. Not a concern.
2. **Race: rename to existing name** — relies on
   `{user_id, name}` unique index → second writer gets `DuplicateKeyError`,
   surfaced as `409`. No application-level lock needed.
3. **Cascade ordering on `DELETE /api/playlists/{id}`** — clear videos first,
   then drop the playlist row. If only the second op fails (rare), the
   playlist row remains, but its `video_count` is 0; user can retry.
4. **Frontend race: create-then-select inline** — modal returns
   `playlist_id` from the server before the dropdown closes. No optimistic
   update needed.
5. **Empty-playlist UX**: showing playlists with 0 videos in the sidebar
   could be cluttered. Mitigation: show all playlists regardless (they
   were intentionally created). User can delete unused ones.

6. **"Playlist" naming expectation gap (codex outside voice)**: v1 builds
   grouping only — no `position`, no auto-advance. Users may expect
   YouTube-style "play next" immediately. Mitigation: phase 1 UI shows
   counts + grouping only; no "▶ play all" button until ordering ships.
   Naming choice was explicit (decision #2).

7. **Cascade order — clear before drop (codex challenge resolved)**:
   Codex argued "delete first, then clear" is safer. Analysis:
   - Plan order (clear → delete): worst case = videos in 미지정,
     state always consistent, retry is idempotent and clean.
   - Codex order (delete → clear): worst case = orphan pointers,
     state inconsistent, retry returns 404, needs scrub script.
   Plan order kept. Worker manifest upsert + PATCH validation
   (decision #9) self-heal any straggler dangling pointers.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (small feature) |
| Codex Review | outside voice | Independent 2nd opinion | 1 | CLEAR | 14 findings: 10 inline-fixed, 3 disagreements analyzed and resolved-as-designed, 1 deferred (frontend tests) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 13 decisions locked + 5 inline fixes (codex post-review). 0 unresolved decisions, 0 critical gaps. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a (small UI surface, sidebar + dropdown patterns only) |
| DX Review | `/plan-devex-review` | DX gaps | 0 | — | n/a (internal feature) |

**CROSS-MODEL:** Eng and Codex agree on the broad shape; 3 codex challenges
analyzed and rejected with reason (cascade order, scope size, naming).
10 codex findings folded into the plan as inline fixes.
**UNRESOLVED:** 0
**VERDICT:** ENG + CODEX CLEARED — ready to implement.
