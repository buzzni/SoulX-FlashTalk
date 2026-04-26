# DB Integration Plan — Attach Studio to `ai_showhost` MongoDB

**Status:** review-locked (post `/plan-eng-review`)
**Owner:** jack-buzzni
**Date:** 2026-04-25

---

## 1. Context

Today FlashTalk Studio (this repo) has **no user concept** — every artifact
lands on local disk under `outputs/`, `uploads/`, `temp/` with no owner, no
auth. We're attaching to the existing `ai_showhost` Mongo cluster (also used
by the sibling "platform" product, HSMOA) so that:

- the `users` collection is shared (single source of truth for accounts),
- studio-specific data lives in **new** collections we own,
- platform's existing data is **never written to** by studio (except one
  additive migration: `users.subscriptions` + `users.studio_token_version`),
- media files (images/videos/audio) **stay on local disk for now** but are
  referenced by a `storage_key` so a future cloud-storage swap = `url_for`
  change only.

### 1.1 Two-DB development model

```
┌──────────────────────────────────────────────────────────────────────┐
│ PROD DB (untouched until final deploy)                                │
│   mongodb://idc.buzzni.com:32720/ai_showhost                          │
│   · users (8 real accounts incl. jack)                                │
│   · videos, user_settings, announcements, ...  (platform-owned)       │
│   · We only ever run `studio_006_add_subscriptions` once at the end.  │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ LOCAL DEV DB (this dev box)                                           │
│   mongodb://localhost:27017/ai_showhost                               │
│   · empty mongod, started fresh on this host                          │
│   · `seed_dev_db.py` seeds jack (dev1234) with subscriptions          │
│   · `studio_007_local_import.py` imports 101 hosts + 4 results        │
│     under user_id="jack"                                              │
│   · Used for hand-testing in the browser during development           │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ LOCAL TEST DB (same mongod, per-pytest-worker DB names)               │
│   mongodb://localhost:27017/ai_showhost_test_<worker>                 │
│   · conftest reads PYTEST_XDIST_WORKER ("main" / "gw0" / "gw1"...)    │
│   · fixture seeds known-password testuser/noaccess; drops studio_*    │
│     and users between tests; race-free under `pytest -n`              │
└──────────────────────────────────────────────────────────────────────┘
```

PROD URL stays out of `.env` to avoid accidental dev-time writes; we set it
only when running the final `006` migration step.

## 2. What's already in prod (read-only — do not touch)

Verified via direct inspection on 2026-04-25:

| collection            | docs   | owned by  | studio touches?                     |
|-----------------------|--------|-----------|-------------------------------------|
| `users`               | 8      | platform  | **read** + add `subscriptions`, `studio_token_version` |
| `user_settings`       | 6      | platform  | no                                  |
| `videos`              | 1857   | platform  | no                                  |
| `playback_states`     | 15     | platform  | no                                  |
| `announcements`       | 21     | platform  | no                                  |
| `approval_requests`   | 0      | platform  | no                                  |
| `embedding_cache`     | 711    | platform  | no                                  |
| `ocr_cache`/`ocr_tasks` | 0/0  | platform  | no                                  |
| `product_ocr`         | 29     | platform  | no                                  |
| `_migrations`         | 5      | platform  | **no** — we use a separate `studio_migrations` collection (decision #12) |

Existing `users` shape (sample with secrets stripped):

```jsonc
{
  "_id": ObjectId("..."),
  "user_id": "jack",                    // string FK used everywhere else
  "display_name": "잭",
  "hashed_password": "$2b$12$...",      // bcrypt $2b$12, ready to verify
  "role": "master",                     // "master" | "admin" | "member"
  "is_active": true,
  "approval_status": "approved",
  "must_change_password": false,
  "password_bootstrapped": false,
  "token_version": 33,                  // platform-owned — DO NOT bump
  "refresh_token_hashes": [...],
  "created_at": <Date>,
  "last_active_at": <Date>
}
```

No `subscriptions` and no `studio_token_version` field anywhere yet.
Platform's migration log head (in `_migrations`): `005_backfill_scoring_embeddings`.
We don't write to that collection. Our migrations live in a new
`studio_migrations` collection, named `studio_006_*` and `studio_007_*`.

## 3. Locked decisions (post review)

| # | decision                                | locked answer                |
|---|-----------------------------------------|------------------------------|
| 1 | studio auth strategy                    | independent login — bcrypt-verify against `users.hashed_password`, issue studio-only JWT signed with `STUDIO_JWT_SECRET` |
| 2 | subscriptions field location            | on `users` — `subscriptions: ["platform","studio"]`. Backfill all existing users with `["platform"]`; add `"studio"` for `jack` |
| 3 | what to do with 101 host metas + 4 result manifests + queue/history files | migrate to DB under `user_id="jack"` via `007_studio_local_import.py`; keep media files on disk |
| 4 | host modeling                           | **two collections** — `studio_hosts` (candidate, lifecycle state machine) + `studio_saved_hosts` (user library) |
| 5 | subscription revocation gap             | `current_user` re-checks `"studio" in user.subscriptions` on **every request** (one extra line, no cost — same DB read used for the `studio_token_version` check) |
| 6 | `token_version` boundary with platform  | **separate field**: `users.studio_token_version`. Studio logout bumps only this, never `token_version`. |
| 7 | dev/test DB                             | local mongod on this host with two DBs: `ai_showhost` (dev, seeded) and `ai_showhost_test` (pytest, fixture-driven). No prod dump. No mongomock. |
| 8 | scope reduction                         | defer queue **persistence** (was PR6) to follow-up. PR2 includes a **minimal login page** (separate route, not modal) + auth guard. |
| 9 | queue ownership (codex finding)         | PR2 adds `user_id` to queue entries (both **in-memory and persisted to `task_queue.json`** so restart preserves owner). `/api/queue`, `/api/progress/{task_id}`, cancel are gated by owner. On startup, legacy entries lacking `user_id` are skipped + logged. DB persistence (separate `studio_task_queue` collection) still deferred. |
| 10 | `/api/videos/*` auth boundary           | **public** alongside `/api/files/*`. `<video>` can't send Authorization either. Cloud-storage swap → presigned URLs solves both. |
| 11 | DB selected-row invariant               | partial unique index `{user_id:1, step:1}` where `status="selected"` — enforces **at most one** selected per step per user (zero is a valid state). The `select(image_id)` write path must demote any existing selected row(s) to `draft` *before* promoting the target, with a single retry on duplicate-key race. |
| 12 | migration namespace                     | use a **separate `studio_migrations` collection**, not `_migrations`. Removes risk of `006_*` colliding with future platform migration of the same number. |
| 13 | `007` idempotency granularity           | `_migrations`-style outer guard removed. Each record is upserted by its natural key (`image_id` / `host_id` / `task_id`). The `studio_migrations` row is written **at the end** as an audit trail, not as a re-run gate. Re-running after partial failure resumes cleanly. |
| 14 | test DB per-worker                      | `conftest` reads `PYTEST_XDIST_WORKER` and uses `ai_showhost_test_<worker>` so `pytest -n` and CI parallelism are race-free. |
| 15 | startup failure mode                    | `await db.init()` in startup hook is **fail-fast** — if mongod is unreachable the whole app refuses to start with a clear log line. No "503 on first request" degraded-mode middleware. PR0 (mongod up) is a hard prerequisite to any subsequent PR running locally. |
| 16 | storage_key namespace                   | first segment of every key is the **bucket name** (`outputs`, `uploads`, `examples`). `LocalDiskMediaStore` resolves `outputs/...` → `OUTPUTS_DIR/...`, `uploads/...` → `UPLOADS_DIR/...`. Eliminates the ambiguity codex flagged in `app.py:1888`. |

## 4. New collections (studio owns these)

All `studio_*` prefix.

### 4.1 `studio_hosts` — candidate avatars (per-session, lifecycle)

Replaces `outputs/hosts/saved/host_*.png.meta.json` sidecars (managed by
`modules/lifecycle.py`).

```jsonc
{
  _id, user_id,
  image_id,                      // existing handle, e.g. "host_abc12345_s42"
  storage_key,                   // "outputs/hosts/saved/host_abc12345_s42.png" (bucket-prefixed; see §5)
  step,                          // "1-host" | "2-composite"   ← matches current meta.json on disk
  model, mode,                   // e.g. "gemini-3.1-flash-image-preview", "face-outfit"
  prompt, system_instruction,
  has_face_ref, has_outfit_ref, has_style_ref,
  face_ref_storage_key, outfit_ref_storage_key, style_ref_storage_key,
  face_strength, outfit_strength,
  seed, temperature,
  status,                        // "draft" | "selected" | "committed"   ← matches lifecycle.py:54
  is_prev_selected, batch_id,
  video_ids: [String],           // back-refs to studio_results.task_id
  generated_at, committed_at
}
```

Indexes (created in `init_indexes()`):
- `{user_id:1, image_id:1}` unique
- `{user_id:1, step:1, status:1, generated_at:-1}` (history listing)
- `{user_id:1, batch_id:1}` (batch grouping)
- **`{user_id:1, step:1}` partial unique** with `partialFilterExpression: {status: "selected"}` — enforces **at most one** selected candidate per step per user. ("Exactly one" is not enforceable at the index layer; zero selected is also valid, e.g. right after a commit.) Concurrent or buggy select calls fail-fast on the second writer with a duplicate-key error.

Required write-side semantics for `select(image_id)` (codex #8):
1. Demote any existing `selected` row(s) for `(user_id, step)` to `draft` first
   (single bulk update, conditional on `status == "selected"`).
2. Then promote the target to `selected`.
Wrap as a single `find_one_and_update` chain; if the index conflict still
fires (race), retry once with backoff. Document this in `studio_host_repo.py`.

State machine (mirrors `modules/lifecycle.py:6-38` — keep an ASCII copy as a
docstring at the top of `studio_host_repo.py`):

```
generate
  └─→ status='draft', batch_id set
select(image_id)
  ├─ target → status='selected'
  └─ other selected → status='draft'  (is_prev_selected unchanged)
commit(step, video_id)
  ├─ selected → status='committed', append video_id, clear is_prev_selected
  └─ everything else non-committed → deleted
cascade_delete_by_video(video_id)
  └─ remove video_id from each committed image; if video_ids empty → delete
```

### 4.2 `studio_saved_hosts` — user library (long-lived)

Replaces `outputs/hosts/saved/<uuid32>.json` sidecars (managed by
`/api/hosts` CRUD in `app.py:2274-2350`).

```jsonc
{
  _id, user_id,
  host_id,                       // existing 32-char hex uuid
  name,
  storage_key,                   // "outputs/hosts/saved/<uuid32>.png" (bucket-prefixed)
  meta: { ...optional generation metadata pasted at save time... },
  created_at
}
```

Indexes:
- `{user_id:1, host_id:1}` unique
- `{user_id:1, created_at:-1}` (library listing)

### 4.3 `studio_results` — generation results

Replaces `outputs/results/*.json`.

```jsonc
{
  _id, user_id, task_id,
  type,                          // "generate" | "regenerate" | ...
  status,                        // "completed" | "failed" | "running"
  video_storage_key, video_bytes,
  generation_time_sec, completed_at,
  params: {                      // all generation params, paths normalized
    host_storage_key,
    audio_storage_key,
    audio_source_label,
    prompt, seed, cpu_offload, script_text,
    resolution_requested, resolution_actual,
    scene_prompt,
    reference_image_storage_keys: [String]
  },
  meta: {
    host:        { mode, selected_seed, storage_key, prompt, negative_prompt,
                   face_ref_storage_key, outfit_ref_storage_key, outfit_text,
                   face_strength, outfit_strength, temperature },
    composition: { selected_seed, storage_key, direction, shot, angle, temperature },
    products:    [{ name, storage_key }],
    background:  { source, preset_id, preset_label, prompt, storage_key },
    voice:       { source, voice_id, voice_name, script,
                   stability, style, similarity, speed },
    image_quality
  }
}
```

Indexes:
- `{user_id:1, task_id:1}` unique
- `{user_id:1, status:1, completed_at:-1}` (history feed)

### 4.4 Not adding in this round

- **`studio_video_history` — DROPPED.** `outputs/video_history.json` is
  derivable from `studio_results` → `find({user_id, status:"completed"}).sort({completed_at:-1})`.
- **`studio_task_queue` — DEFERRED to a follow-up PR.** `outputs/task_queue.json`
  keeps its current in-memory + JSON behavior, **but PR2 also persists
  `user_id` into each JSON entry** so a process restart re-loads owner-tagged
  tasks. On startup, any legacy entries lacking `user_id` are **rejected
  (skipped + logged)** — they belong to the pre-auth era and have no safe
  owner to assign. (Codex N3: in-memory-only `user_id` would have been
  unsafe across restarts.)

## 5. Storage abstraction (`modules/storage.py`)

Goal: DB never stores absolute paths, and the *MediaStore interface* stays
stable when we swap implementations. The actual cloud-storage swap is a
larger refactor — `url_for` is the only line that changes for **read** paths,
but **write** paths (uploads, generation outputs) need a staging/cache layer
and an audit of every `app.py` caller that currently passes absolute paths
into generation (see §10 deferred + codex #4). Don't read this section as
"swap is one line"; read it as "DB schema and repo callers stay stable."

```python
class MediaStore:
    def save_bytes(self, kind: str, data: bytes, suffix: str) -> str   # -> storage_key
    def save_path(self, kind: str, src_path: Path) -> str              # -> storage_key (move/link)
    def local_path_for(self, key: str) -> Path                          # for read/write
    def url_for(self, key: str) -> str                                  # browser-fetchable URL
    def delete(self, key: str) -> None
```

`kind` ∈ `{"hosts", "composites", "videos", "tts", "uploads", "ref_images", "backgrounds"}`.

**`storage_key` shape (per codex #5):** `<bucket>/<key>`. The first path
segment is the bucket name and the rest is the relative key inside that
bucket. Buckets:
- `outputs/...` → `OUTPUTS_DIR/...` (hosts, composites, videos, tts)
- `uploads/...` → `UPLOADS_DIR/...` (refs, user-uploaded backgrounds)
- `examples/...` → `EXAMPLES_DIR/...` (read-only seed assets)

Concrete example keys:
- `"outputs/hosts/saved/host_abc_s42.png"`
- `"outputs/res_20260424_130928_2503b5bf.mp4"`
- `"uploads/ref_img_cf6d2f7a.png"`

The `kind` arg on `save_*()` is used only to **route to the right bucket**;
it never appears in the key. This eliminates the "OUTPUTS vs UPLOADS"
collision codex flagged in `app.py:1888`.

Initial impl `LocalDiskMediaStore`:
- `local_path_for(key)` → `bucket, _, rest = key.partition("/")` → returns `BUCKET_DIRS[bucket] / rest`. Rejects if `bucket not in BUCKET_DIRS` or `rest` is empty or contains `..`. (Codex N2: must join with `rest`, not `key`, otherwise the bucket dir gets double-applied: `OUTPUTS_DIR/outputs/foo.png`.)
- `url_for(key) = "/api/files/" + key`

Future `S3MediaStore` returns presigned URLs; nothing in callers changes.

## 6. Auth (`modules/auth.py`)

Library choices (Layer 1 — proven defaults):
- **Password verify**: `bcrypt` (the library) directly — `bcrypt.checkpw(plain, hashed)`,
  `bcrypt.hashpw(plain, bcrypt.gensalt(rounds=12))`. Output is `$2b$12$...`,
  byte-identical to what's already in prod `users.hashed_password`.
  *(Note: the original plan proposed `passlib[bcrypt]`, but passlib 1.7.4
  is incompatible with bcrypt ≥4.x — `passlib` is effectively abandoned
  since 2020. PR0 verified `bcrypt` directly produces the same hash format
  with no indirection.)*
- **JWT**: `PyJWT`. Simpler and more actively maintained than `python-jose`.

Endpoints:
- `POST /api/auth/login` — body `{user_id, password}`.
  Steps: bcrypt-verify → require `is_active && approval_status=="approved"
  && "studio" in subscriptions` → issue access JWT
  `{sub: user_id, role, sid: studio_token_version, exp}` signed with
  `STUDIO_JWT_SECRET`. On any failure return generic `401`
  (don't leak whether user_id exists).
- `POST /api/auth/logout` — `users.$inc({studio_token_version: 1})`. Never
  touches `token_version`.
- `GET /api/auth/me` — return `{user_id, display_name, role, subscriptions}`.

Middleware `Depends(current_user)`:
1. Verify JWT signature + expiry.
2. `users.find_one({user_id})` (single-doc lookup, indexed).
3. Require `sid == user.studio_token_version` (else `401`).
4. Require `user.is_active && user.approval_status == "approved"` (else `401`).
5. Require `"studio" in user.subscriptions` (else `403` — covers the
   revocation gap; the user-record read in step 2 already has the field, so
   this costs zero extra DB calls).
6. Attach the user record to `request.state.user`.

Endpoints **not** behind auth:
- `POST /api/auth/login`
- `GET /api/config`
- `GET /api/files/*` (browser `<img src>` can't send Authorization headers
  cleanly; staying public for v1.)
- `GET /api/videos/*` (same reasoning — `<video>` can't send Authorization
  headers either; codex flagged this).
- When cloud storage lands, both file and video access switch to **presigned
  URLs** which solves the header problem naturally.

Endpoints that ARE behind auth and need owner-scoping (codex finding #2):
`/api/queue`, `/api/progress/{task_id}`, `/api/cancel/{task_id}`. Even
though queue persistence is deferred, **PR2 adds `user_id` to the
in-memory queue entries** and rejects cross-user reads/cancels.

`.env` additions:
```
MONGO_URL=mongodb://localhost:27017
DB_NAME=ai_showhost
STUDIO_JWT_SECRET=<random 32 bytes>
STUDIO_JWT_TTL_DAYS=7
```

`STUDIO_JWT_SECRET` rotation = change the value, all tokens invalidate
immediately. Acceptable manual process for v1.

7-day access tokens with no refresh — accepted because the per-request
subscription re-check provides admin-side revocation in real time.

## 7. Repository + connection layer

```
modules/
  db.py                              # AsyncIOMotorClient + startup/shutdown + init_indexes()
  storage.py                         # MediaStore + LocalDiskMediaStore
  auth.py                            # login/logout/current_user
  repositories/
    user_repo.py                     # find_by_id, has_subscription
    studio_host_repo.py              # candidate hosts (lifecycle)
    studio_saved_host_repo.py        # user library
    studio_result_repo.py            # generation results
```

**Every repo method takes `user_id` as the first arg and scopes its query.**
No global "load everyone's stuff" helpers. Eliminates a whole class of
leakage bugs.

`modules/db.py`:

```python
client: AsyncIOMotorClient | None = None
db: AsyncIOMotorDatabase | None = None

async def init():
    global client, db
    client = AsyncIOMotorClient(
        config.MONGO_URL,
        serverSelectionTimeoutMS=5000,
        maxPoolSize=50,
        retryWrites=True,
    )
    await client.admin.command("ping")
    db = client[config.DB_NAME]
    await init_indexes()

async def init_indexes():
    # idempotent — motor's create_index is no-op if same spec exists
    await db.studio_hosts.create_index([("user_id", 1), ("image_id", 1)], unique=True)
    await db.studio_hosts.create_index([("user_id", 1), ("step", 1), ("status", 1), ("generated_at", -1)])
    await db.studio_hosts.create_index([("user_id", 1), ("batch_id", 1)])
    # decision #11: enforce "exactly one selected per (user_id, step)" at DB layer
    await db.studio_hosts.create_index(
        [("user_id", 1), ("step", 1)],
        unique=True,
        partialFilterExpression={"status": "selected"},
        name="one_selected_per_step",
    )
    await db.studio_saved_hosts.create_index([("user_id", 1), ("host_id", 1)], unique=True)
    await db.studio_saved_hosts.create_index([("user_id", 1), ("created_at", -1)])
    await db.studio_results.create_index([("user_id", 1), ("task_id", 1)], unique=True)
    await db.studio_results.create_index([("user_id", 1), ("status", 1), ("completed_at", -1)])

async def close():
    if client: client.close()
```

Wired into `app.py`:
```python
@app.on_event("startup")
async def _on_start(): await db_module.init()

@app.on_event("shutdown")
async def _on_stop(): await db_module.close()
```

## 7.5 Test infrastructure

- pytest already configured (`pyproject.toml`: `asyncio_mode = "auto"`,
  `--cov=modules --cov=app`).
- All tests run against the **real local mongod** on `ai_showhost_test`.
  No mongomock (fidelity gap), no testcontainers (docker not available on
  this host).
- `tests/conftest.py` adds (per-worker DB names — codex #7):

```python
import os
@pytest_asyncio.fixture
async def mongo_test_db():
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    client = AsyncIOMotorClient("mongodb://localhost:27017",
                                 serverSelectionTimeoutMS=2000)
    db = client[f"ai_showhost_test_{worker}"]
    # codex N7: drop BEFORE yield too, not just after.
    # If a previous run crashed mid-test the next run inherits stale state.
    for coll in await db.list_collection_names():
        if coll.startswith("studio_") or coll == "users":
            await db[coll].drop()
    # seed fixture user(s) with known passwords
    await _ensure_test_user(db, "testuser", "test1234",
                             subscriptions=["platform","studio"], role="member")
    await _ensure_test_user(db, "noaccess", "test1234",
                             subscriptions=["platform"], role="member")
    yield db
    # teardown
    for coll in await db.list_collection_names():
        if coll.startswith("studio_") or coll == "users":
            await db[coll].drop()
    client.close()

@pytest_asyncio.fixture
async def auth_token(mongo_test_db):
    # returns a JWT for "testuser" usable in Authorization headers
    ...
```

- New test files (target: 100% line coverage on new modules):
  - `tests/test_db_connection.py`
  - `tests/test_storage_local.py`
  - `tests/test_auth_login.py`
  - `tests/test_auth_current_user.py`
  - `tests/test_user_repo.py`
  - `tests/test_studio_host_repo.py`
  - `tests/test_studio_saved_host_repo.py`
  - `tests/test_studio_result_repo.py`
  - `tests/test_studio_006_add_subscriptions.py`
  - `tests/test_studio_007_local_import.py`
  - `tests/test_userid_scoping.py` (cross-cutting: A's token must never return B's data)
- Existing 19 `tests/test_api_*.py` files: each will need to acquire a
  `auth_token` fixture and pass `Authorization: Bearer <token>` once
  endpoints are gated. Done in PR2.
- Coverage floor in `pyproject.toml`: bump from 0 → 60 once PR2 lands, then
  → 70 after PR4, → 75 after PR5.

## 8. Migrations + scripts

| script                                | runs on                | when                  |
|---------------------------------------|------------------------|-----------------------|
| `scripts/seed_dev_db.py`              | local dev DB only      | once on PR0 setup     |
| `scripts/studio_006_add_subscriptions.py`    | prod DB                | once at final deploy  |
| `scripts/studio_007_local_import.py`  | local dev DB only      | once on PR4/PR5       |

All three are idempotent **at the record level** (per codex #9). The outer
"skip if migration name exists" guard is removed: each record is upserted by
its natural key, so re-running after a partial failure resumes cleanly. The
`studio_migrations` row is written **at the end** as an **append-only audit
trail** — re-running adds another row with a fresh `applied_at`, not an
upsert. (Codex P9: explicit append-only — duplicate rows by `name` are
acceptable and intentional; they document each run.)

Migrations live in their own collection — `studio_migrations` — not the
shared `_migrations` (per codex #12). This eliminates the risk of `006_*`
colliding with a future platform migration of the same number. Migration
names are also `studio_`-prefixed in the filenames.

`scripts/_lib.py` is shared:
- `record_migration(db, name, result)` → inserts into **`studio_migrations`**
- `assert_local_only(mongo_url, db_name)` → refuses unless URL is localhost
  AND db_name starts with `ai_showhost` (covers `ai_showhost`,
  `ai_showhost_test`, `ai_showhost_test_*`). **Mandatory guard in
  `seed_dev_db.py` and `studio_007_local_import.py`** so no one ever imports
  test data into prod.

### 8.1 `seed_dev_db.py` (NEW)
```
guard: assert_local_only(MONGO_URL, DB_NAME)
upsert user 'jack' with bcrypt('dev1234'), subscriptions=["platform","studio"],
       role="master", is_active=True, approval_status="approved",
       studio_token_version=0
upsert user 'testuser' with bcrypt('test1234'), subscriptions=["platform","studio"],
       role="member", studio_token_version=0
print summary
```

### 8.2 `studio_006_add_subscriptions.py`
```
# Per decision #13: NO outer "skip if migration name exists" guard.
# Per-record upsert handles idempotency; re-running after partial failure resumes.
For every user without `subscriptions` field:
  $set subscriptions: ["platform"]
For specific users (CLI arg, default ["jack"]):
  $addToSet subscriptions: "studio"
For every user without `studio_token_version`:
  $set studio_token_version: 0
record_migration(db, "studio_006_add_subscriptions", "{N} users updated")  # → studio_migrations
Modes: --dry-run (default), --commit
```

### 8.3 `studio_007_local_import.py`
```
# Per decision #13: NO outer guard. Per-record upserts make this re-runnable.
guard: assert_local_only(...)
owner = "jack" (CLI arg)

# Codex N4: pre-scan to enforce "at most one selected per step" before insert.
# Real disk state may have multiple status="selected" host metas if
# lifecycle.py ever crashed mid-transition. Detect and demote BEFORE upsert
# so the partial unique index doesn't reject the second write.
host_metas = parse_all("outputs/hosts/saved/host_*.png.meta.json")
for step in ("1-host", "2-composite"):
    selected = [m for m in host_metas if m.step == step and m.status == "selected"]
    if len(selected) > 1:
        # Keep the most recently committed_at/generated_at, demote rest to draft
        keep = max(selected, key=lambda m: m.committed_at or m.generated_at)
        for m in selected:
            if m is not keep: m.status = "draft"
        log.warning(f"Demoted {len(selected)-1} stale 'selected' rows for step={step}")

For each m in host_metas:
  build studio_hosts doc, normalize all paths via _key_from_path()
  upsert into studio_hosts by (user_id, image_id)
For each f in outputs/hosts/saved/<uuid32>.json (the saved-host sidecars):
  parse, build studio_saved_hosts doc
  upsert into studio_saved_hosts by (user_id, host_id)
For each f in outputs/results/*.json:
  parse, recursively scrub PROJECT_ROOT and OUTPUTS_DIR/UPLOADS_DIR prefixes
  upsert into studio_results by (user_id, task_id)
record_migration(db, "studio_007_local_import",
                 "hosts={Nh}, saved={Ns}, results={Nr}")  # → studio_migrations (append-only)
Modes: --dry-run (default, prints diffs incl. any demote), --commit
```

`_key_from_path(path)` produces a key in the bucket/key form (decision #16):
- `<PROJECT_ROOT>/outputs/foo.png` → `"outputs/foo.png"`
- `<PROJECT_ROOT>/uploads/bar.png` → `"uploads/bar.png"`
- handles symlinked variants (`/opt/home/justin/workspace/SoulX-FlashTalk/...`)

After commit, local JSON files **stay in place** as a safety net. A separate
follow-up PR can prune them once the DB path has run for a week.

## 9. Endpoint cutover map

`app.py` currently has these file-touching points (line numbers as of `main`):

| concern                                       | current                    | becomes                                                |
|-----------------------------------------------|----------------------------|--------------------------------------------------------|
| `VIDEO_HISTORY_FILE` r/w (l.77, 211, 219)     | JSON file                  | `studio_result_repo.list_completed(user_id)`           |
| result manifest write (l.357)                 | JSON file                  | `studio_result_repo.upsert(user_id, manifest)`         |
| result manifest read (l.1864)                 | JSON file                  | `studio_result_repo.get(user_id, task_id)` + queue fallback for in-flight |
| `host_*.meta.json` writes (`modules/host_generator.py`, `modules/lifecycle.py`) | per-file JSON sidecars     | `studio_host_repo.upsert/update`                       |
| `/api/hosts` list/save/delete (l.2274–2350)   | scanning HOSTS_DIR + JSON  | `studio_saved_host_repo` (DB is source of truth)       |
| `task_queue.json` (`modules/task_queue.py`)   | JSON file                  | DB persistence **deferred**. PR2 still adds `user_id` to in-memory entries and gates `/api/queue`, `/api/progress`, `/api/cancel` by owner (decision #9). |

## 10. PR sequence

PR0 is one-shot setup; PR1–PR5 are independently shippable and reversible.

| PR  | scope                                                                                                   | risk    | est. (CC) |
|-----|---------------------------------------------------------------------------------------------------------|---------|-----------|
| 0   | Install local mongod; `.env` wiring; `seed_dev_db.py` + initial seed                                    | low     | 30 min    |
| 1   | `modules/db.py` (motor + indexes incl. partial unique on selected), `repositories/user_repo.py`, `scripts/studio_006_add_subscriptions.py` (not run on prod yet) | low | 1 hr |
| 2   | `modules/auth.py` (login/logout/me/current_user, JWT, passlib, PyJWT). All `/api/*` (except login/config/files/videos) gated. **Minimal frontend login as a separate page** (`/login` route, not a modal) with `localStorage` token + `fetch` interceptor that adds `Authorization` and redirects to `/login` on 401. **Owner-scope `/api/queue`, `/api/progress/{task_id}`, `/api/cancel/{task_id}`** by adding `user_id` to in-memory queue entries (queue DB persistence still deferred). Existing tests updated to send `Authorization`. | medium | 4 hr |
| 3   | `modules/storage.py` (`LocalDiskMediaStore`); refactor app.py to write `storage_key` everywhere new (no behavior change in responses yet) | low | 1 hr |
| 4   | `studio_host_repo`, `studio_saved_host_repo` + cutover from `.meta.json`/`.json` sidecars; `studio_007_local_import` (hosts portion) | medium | 3 hr |
| 5   | `studio_result_repo` + cutover from results JSON; finish `studio_007_local_import` (results portion); coverage floor → 75 | medium | 2 hr |

**Deferred to follow-up PRs (post review):**
- queue **persistence** (`studio_task_queue` collection) — owner-scoping
  itself is *not* deferred (in PR2)
- prune local JSON relics once DB path has run for ~a week
- audit `app.py` for callers that still pass absolute paths into generation
  (uploads return `path` at `app.py:748`; host/composite endpoints validate
  absolute paths at `app.py:1945, 2112`) — clean these up to `storage_key`
  before any cloud-storage swap (codex #4)
- staging/cache layer for cloud-storage `MediaStore` (presigned URLs are not
  enough on their own — codex #4)
- `STUDIO_JWT_SECRET` automated rotation
- audit log / rate-limit on `/api/auth/login` (`slowapi`)

**Final deploy step (separate from PR sequence):**
- run `scripts/studio_006_add_subscriptions.py --commit` against prod DB
- update prod `.env`: `MONGO_URL` → prod URL, `STUDIO_JWT_SECRET` → freshly
  generated 32 bytes
- coordinate with platform team that we're adding `subscriptions` and
  `studio_token_version` fields, and creating a new `studio_migrations`
  collection (additive, no schema change to existing fields, but worth a
  heads-up Slack message)

## 11. Risks / open questions

1. **Platform schema drift** — if platform later adds its own `subscriptions`
   field with different semantics, we collide. Mitigation: comment in
   `studio_006_add_subscriptions.py` + Slack platform team before running on prod.
2. ~~`token_version` collision~~ — **resolved** (separate `studio_token_version`).
3. **Cross-collection consistency** — committing a host (status →
   `committed`) and creating a `studio_results` row are two separate writes.
   Current file-based code has the same issue; we are not regressing.
   MongoDB multi-doc transactions require a replica set (status of prod
   cluster unknown). For v1: accept best-effort, document the gap, revisit
   if we see actual orphan rows.
4. **Cloud storage migration** — plan keys on `storage_key` being relative.
   Any code that currently emits absolute paths in API responses (e.g. some
   `/api/results` debug fields) must switch to `media_store.url_for(key)`
   *during* PR3, not later. Audit pass in PR3.
5. **Existing absolute paths in 4 result manifests** include
   `/opt/home/jack/workspace/SoulX-FlashTalk/...` and possibly
   `/opt/home/justin/workspace/...` (symlinked dir). `_key_from_path` must
   handle both; spot-check via `--dry-run`.
6. **`/api/files/*` and `/api/videos/*` are public** (no auth) so
   `<img src>` and `<video src>` work. Anyone with a URL can fetch.
   Acceptable for B2B internal; document. Cloud-storage transition swaps to
   presigned URLs which solves both at once.
7. **JWT secret rotation** — manual process (change `.env`, restart).
   Acceptable for v1; revisit if multi-instance deployment.

## 12. Failure modes (one realistic scenario per new path)

| codepath                              | failure                                          | covered? |
|---------------------------------------|--------------------------------------------------|----------|
| `db.init()` at startup                | mongod not running → connection refused          | **fail-fast** — uvicorn refuses to start, error in log. PR0 (mongod up) is a hard prereq. (Corrected per codex #6 — the earlier "503 on first request" claim was wrong.) |
| `db.init_indexes()`                   | conflicting index already exists                  | motor raises `OperationFailure`; surfaced in startup log |
| `auth.login`                          | bcrypt verify slow on cold path (~80ms)           | acceptable; add a TODO if login becomes hot path |
| `auth.current_user`                   | user deleted between JWT issue and use            | `find_one` returns None → `401` |
| `studio_host_repo.upsert`             | duplicate (user_id, image_id) race                | unique index → second write fails; treat as already-applied |
| `studio_007_local_import`             | meta.json file is malformed                       | log + skip (not abort); count surfaced in result string |
| `studio_007_local_import`             | result.json references missing video file on disk | **log + skip the result entirely** (codex N5: previous "skip; storage_key still recorded" was self-contradictory). The manifest is permanently lost from the import set; user must re-render to recover. |
| `LocalDiskMediaStore.save_path`       | source path outside SAFE_ROOTS                    | reject with `ValueError`; covered by existing `safe_upload_path()` helper |

**Critical gaps** (no test, no error handling, would be silent): none flagged.

## 13. Worktree parallelization

PR1, PR2, PR3 touch different module trees and CAN run in parallel
worktrees if jack wants to split up:

| Lane | PRs                              | shared modules                             |
|------|----------------------------------|--------------------------------------------|
| A    | PR1 (db.py + user_repo)          | none                                       |
| B    | PR3 (storage.py)                 | none                                       |
| C    | PR2 (auth.py)                    | depends on A (uses user_repo)              |
| D    | PR4 (studio_host_repo + cutover) | depends on A + B + C                       |
| E    | PR5 (studio_result_repo)         | depends on A + B + C + D for shared fixtures |

Realistic execution: A + B in parallel → C → D → E sequential. Total
critical path: PR0 (0.5 hr) + max(PR1, PR3) (1 hr) + PR2 (4 hr) +
PR4 (3 hr) + PR5 (2 hr) ≈ **~10.5 hours** of CC time for jack.

## 14. NOT in scope (explicitly deferred)

| item                                       | reason                                                           |
|--------------------------------------------|------------------------------------------------------------------|
| Fancy frontend login UX (forgot-password, MFA, SSO) | PR2 ships a minimal `/login` page only; richer flows are follow-up |
| Queue DB persistence (`studio_task_queue`) | current `task_queue.json` works; in-memory queue **gains user_id in PR2** but persistence stays JSON |
| Refresh tokens                             | per-request subscription check covers revocation; revisit if external users |
| Multi-doc transactions                     | requires replica set confirmation; current behavior already non-atomic |
| S3/GCS implementation of `MediaStore`      | abstraction shipped, impl deferred until customer requires; will also need a staging/cache layer (codex #4) |
| Pruning of local JSON relics               | wait one week of DB path running cleanly                         |
| Running `studio_006` on prod               | last step after all PRs land; coordinated with platform team     |
| Audit log + rate-limit on `/api/auth/login` | v1 is internal-only; add `slowapi` if external                  |
| Automated `STUDIO_JWT_SECRET` rotation     | manual env-swap is fine for v1                                   |
| Absolute-path callers in `app.py`          | `app.py:748, 1945, 2112` still accept absolute paths in user input; cleanup before any cloud-storage swap (codex #4) |

## 15. What already exists (reused, not rebuilt)

- `users` collection in prod (8 users, bcrypt-hashed passwords, role enum,
  `is_active`, `approval_status`) — **reused as-is**, two additive fields only.
- `bcrypt $2b$12` hash format — `bcrypt.checkpw()` verifies them directly
  (PR0 confirmed roundtrip: prod-format hash + plain pw → True).
- `_migrations` collection convention (5 prior entries, `00X_*` naming) —
  we **don't** extend it. We follow the same naming pattern in our own
  `studio_migrations` collection with `studio_006_*`, `studio_007_*`
  (decision #12). Avoids namespace collision.
- `modules/lifecycle.py:6-38` ASCII state-machine doc — copied verbatim
  into `studio_host_repo.py` to keep the model visible in the new home.
- `utils.security.safe_upload_path()` — reused inside `LocalDiskMediaStore.local_path_for()`
  to validate that resolved paths stay within `BUCKET_DIRS` (no traversal).
- `task_queue.py` JSON-file persistence pattern — temporarily kept
  unchanged; replaced in a follow-up PR.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (internal infra plan) |
| Codex Review | outside voice | Independent 2nd opinion | 2 | CLEAR (PLAN) | Round 1: 12 findings (8 inline + 4 user decisions). Round 2 (post-update): 5 partial-resolutions tightened + 5 new findings, all applied. Final: 0 unresolved, 2 risk-accepted (`/api/files/*` and `/api/videos/*` public). |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 16 decisions locked, 0 critical gaps. Self-audit pass + cross-verification round confirmed all decisions and codex findings are reflected consistently across all sections. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a (PR2 minimal login page; no design decisions surfaced) |
| DX Review | `/plan-devex-review` | DX gaps | 0 | — | n/a (internal) |

**CROSS-MODEL:** Eng Review and Codex agreed on all 12 substantive findings
once surfaced. The 4 user-resolved tensions (frontend login scope, phase 0,
test parallelism, queue scoping) all landed on stricter (more codex-aligned)
options.
**UNRESOLVED:** 0
**VERDICT:** ENG + CODEX CLEARED — ready to start with PR0 (local mongod install + seed).
