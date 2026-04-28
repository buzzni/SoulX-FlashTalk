"""Tests for studio_jobs_repo: state machine, dedupe-by-reuse partial unique,
cancel-vs-append atomicity, cursor pagination."""
from __future__ import annotations

import asyncio
import os

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

import config
from modules import db as db_module
from modules.repositories import studio_jobs_repo as repo


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}_studiojobs"


@pytest_asyncio.fixture
async def repo_db(monkeypatch):
    monkeypatch.setattr(config, "MONGO_URL", "mongodb://localhost:27017")
    monkeypatch.setattr(config, "DB_NAME", _test_db_name())

    pre = AsyncIOMotorClient("mongodb://localhost:27017",
                             serverSelectionTimeoutMS=2000)
    pre_db = pre[_test_db_name()]
    for c in await pre_db.list_collection_names():
        await pre_db[c].drop()
    pre.close()

    await db_module.init()
    yield db_module.get_db()
    d = db_module.get_db()
    for c in await d.list_collection_names():
        await d[c].drop()
    await db_module.close()


# ── create / dedupe ────────────────────────────────────────────────────

async def test_create_pending_job(repo_db):
    job = await repo.create(
        user_id="u1", kind="host", input_hash="h" * 64,
        input_blob={"face": "/x"},
    )
    assert job["state"] == "pending"
    assert job["kind"] == "host"
    assert job["user_id"] == "u1"
    assert job["variants"] == []
    assert job["batch_id"] is None
    assert job["heartbeat_at"] is None
    # Public shape never leaks input_blob.
    assert "input_blob" not in job


async def test_create_rejects_unknown_kind(repo_db):
    with pytest.raises(ValueError, match="kind must be"):
        await repo.create(
            user_id="u1", kind="weird", input_hash="h" * 64, input_blob={},
        )


async def test_dedupe_active_returns_existing(repo_db):
    """Two creates with the same (user_id, input_hash) collapse: the second
    sees the first row's id, not a fresh one (eng-spec §6.5)."""
    a = await repo.create(
        user_id="u1", kind="host", input_hash="hash-a",
        input_blob={"face": "/x"},
    )
    b = await repo.create(
        user_id="u1", kind="host", input_hash="hash-a",
        input_blob={"face": "/x"},
    )
    assert b["id"] == a["id"]


async def test_dedupe_releases_after_terminal(repo_db):
    """A new create works once the prior job goes terminal — the partial
    unique index drops out for ready/failed/cancelled rows."""
    a = await repo.create(
        user_id="u1", kind="host", input_hash="hash-r",
        input_blob={},
    )
    assert await repo.mark_streaming(a["id"]) is True
    assert await repo.mark_ready(a["id"], batch_id="bx") is True

    b = await repo.create(
        user_id="u1", kind="host", input_hash="hash-r",
        input_blob={},
    )
    assert b["id"] != a["id"]
    assert b["state"] == "pending"


async def test_dedupe_scoped_per_user(repo_db):
    """Same input_hash, different users → distinct rows."""
    a = await repo.create(user_id="u1", kind="host",
                          input_hash="shared", input_blob={})
    b = await repo.create(user_id="u2", kind="host",
                          input_hash="shared", input_blob={})
    assert a["id"] != b["id"]


# ── owner-scoped reads ─────────────────────────────────────────────────

async def test_get_by_id_owner_scoped(repo_db):
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    assert (await repo.get_by_id("u1", job["id"]))["id"] == job["id"]
    # Different user → None (callers map to 404 to avoid id-existence leaks).
    assert await repo.get_by_id("u2", job["id"]) is None


async def test_get_input_blob_returns_payload(repo_db):
    job = await repo.create(
        user_id="u1", kind="host", input_hash="h1",
        input_blob={"face": "/x", "outfit": "/y"},
    )
    blob = await repo.get_input_blob(job["id"])
    assert blob == {"face": "/x", "outfit": "/y"}


async def test_find_active_by_hash(repo_db):
    a = await repo.create(user_id="u1", kind="host",
                          input_hash="hh", input_blob={})
    found = await repo.find_active_by_hash("u1", "hh")
    assert found is not None and found["id"] == a["id"]

    # After terminal, no longer active.
    await repo.mark_streaming(a["id"])
    await repo.mark_ready(a["id"], batch_id="b")
    assert await repo.find_active_by_hash("u1", "hh") is None


# ── state machine happy path ───────────────────────────────────────────

async def test_state_machine_happy_path(repo_db):
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    jid = job["id"]

    assert await repo.mark_streaming(jid) is True
    snap = await repo.get_by_id("u1", jid)
    assert snap["state"] == "streaming"
    assert snap["heartbeat_at"] is not None

    assert await repo.append_variant(jid, {"image_id": "v1"}) is True
    assert await repo.append_variant(jid, {"image_id": "v2"}) is True
    assert await repo.mark_ready(
        jid, batch_id="batch-1", prev_selected_image_id="v0",
    ) is True

    snap = await repo.get_by_id("u1", jid)
    assert snap["state"] == "ready"
    assert snap["batch_id"] == "batch-1"
    assert snap["prev_selected_image_id"] == "v0"
    assert [v["image_id"] for v in snap["variants"]] == ["v1", "v2"]


# ── conditional update guards ──────────────────────────────────────────

async def test_mark_streaming_only_from_pending(repo_db):
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    assert await repo.mark_streaming(job["id"]) is True
    # Already streaming — second call is a no-op (False).
    assert await repo.mark_streaming(job["id"]) is False


async def test_append_variant_blocked_when_cancelled(repo_db):
    """Cancel-vs-append atomicity (eng-spec §4): once cancelled, append loses
    the conditional filter and returns False so the worker breaks."""
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    await repo.mark_streaming(job["id"])
    assert await repo.mark_cancelled(
        job["id"], owner_user_id="u1") is True
    assert await repo.append_variant(job["id"], {"image_id": "v1"}) is False
    snap = await repo.get_by_id("u1", job["id"])
    assert snap["state"] == "cancelled"
    assert snap["variants"] == []


async def test_mark_ready_blocked_when_cancelled(repo_db):
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    await repo.mark_streaming(job["id"])
    await repo.mark_cancelled(job["id"], owner_user_id="u1")
    assert await repo.mark_ready(job["id"], batch_id="bx") is False


async def test_mark_failed_blocked_when_cancelled(repo_db):
    """Cancelled wins over failed — explicit user intent dominates."""
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    await repo.mark_streaming(job["id"])
    await repo.mark_cancelled(job["id"], owner_user_id="u1")
    assert await repo.mark_failed(job["id"], "boom") is False


async def test_mark_cancelled_owner_scoped(repo_db):
    """A different user calling DELETE must not transition the row."""
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    await repo.mark_streaming(job["id"])
    assert await repo.mark_cancelled(
        job["id"], owner_user_id="u2") is False
    snap = await repo.get_by_id("u1", job["id"])
    assert snap["state"] == "streaming"


async def test_mark_cancelled_already_terminal_returns_false(repo_db):
    """Eng-spec §8: DELETE on a terminal job → 409 (caller checks the bool)."""
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    await repo.mark_streaming(job["id"])
    await repo.mark_ready(job["id"], batch_id="b")
    assert await repo.mark_cancelled(
        job["id"], owner_user_id="u1") is False


async def test_mark_ready_blocked_from_pending(repo_db):
    """mark_ready filters on state='streaming'. A worker that skips
    mark_streaming and tries to fast-forward pending → ready must fail
    closed (the state machine guarantee depends on this filter)."""
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    # No mark_streaming.
    assert await repo.mark_ready(job["id"], batch_id="b") is False
    snap = await repo.get_by_id("u1", job["id"])
    assert snap["state"] == "pending"


async def test_append_variant_blocked_from_pending(repo_db):
    """Same shape as mark_ready_blocked_from_pending: append_variant only
    accepts streaming. A handler emitting a candidate before mark_streaming
    landed must see False so it doesn't write a phantom variant."""
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    assert await repo.append_variant(job["id"], {"image_id": "x"}) is False


async def test_mark_ready_blocked_from_already_ready(repo_db):
    """Idempotent retries on a 'done' event must not double-fire ready
    bookkeeping. mark_ready's state filter ('streaming') blocks the
    second call so callers see False rather than a phantom transition."""
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    await repo.mark_streaming(job["id"])
    assert await repo.mark_ready(job["id"], batch_id="b") is True
    assert await repo.mark_ready(job["id"], batch_id="b2") is False
    # First batch_id wins.
    snap = await repo.get_by_id("u1", job["id"])
    assert snap["batch_id"] == "b"


async def test_mark_failed_blocked_from_terminal(repo_db):
    """Symmetric to test_mark_failed_blocked_when_cancelled, but the
    terminal state here is 'ready'. Once a job has shipped, a late
    failure signal must NOT corrupt the snapshot."""
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    await repo.mark_streaming(job["id"])
    await repo.mark_ready(job["id"], batch_id="b")
    assert await repo.mark_failed(job["id"], "boom") is False
    snap = await repo.get_by_id("u1", job["id"])
    assert snap["state"] == "ready"
    assert snap["error"] is None


async def test_create_or_get_active_race_recovery(repo_db, monkeypatch):
    """Eng-spec §6.5 race: DuplicateKeyError fires (partial unique hit),
    but the conflicting row terminated between our insert and our
    find_active_by_hash read — so find returns None. The repo retries
    with a fresh uuid rather than surfacing the error.
    """
    from pymongo.errors import DuplicateKeyError

    insert_calls = {"n": 0}
    orig_coll = repo._coll

    class _ProxyColl:
        def __init__(self, real):
            self._real = real

        def __getattr__(self, name):
            return getattr(self._real, name)

        async def insert_one(self, doc):
            insert_calls["n"] += 1
            if insert_calls["n"] == 1:
                raise DuplicateKeyError("simulated race")
            return await self._real.insert_one(doc)

    real = orig_coll()
    monkeypatch.setattr(repo, "_coll", lambda: _ProxyColl(real))

    async def _no_active(user_id, input_hash):
        return None  # Conflicting row already terminated.

    monkeypatch.setattr(repo, "find_active_by_hash", _no_active)

    snap, was_created = await repo.create_or_get_active(
        user_id="u1", kind="host", input_hash="h1", input_blob={},
    )
    assert was_created is True
    assert snap["state"] == "pending"
    # Two insert attempts: the first raised, the second succeeded with
    # a fresh uuid.
    assert insert_calls["n"] == 2


async def test_update_heartbeat_only_when_streaming(repo_db):
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    # pending — no heartbeat update.
    assert await repo.update_heartbeat(job["id"]) is False

    await repo.mark_streaming(job["id"])
    assert await repo.update_heartbeat(job["id"]) is True

    # After ready, heartbeat is locked.
    await repo.mark_ready(job["id"], batch_id="b")
    assert await repo.update_heartbeat(job["id"]) is False


# ── list_by_user / pagination ──────────────────────────────────────────

async def test_list_by_user_descending(repo_db):
    ids = []
    for i in range(5):
        job = await repo.create(
            user_id="u1", kind="host",
            input_hash=f"h{i}", input_blob={},
        )
        ids.append(job["id"])
        # Yield to the loop so monotonic-clock created_at orders deterministically.
        await asyncio.sleep(0.001)

    page = await repo.list_by_user("u1")
    listed_ids = [item["id"] for item in page["items"]]
    assert listed_ids == list(reversed(ids))
    assert page["next_cursor"] is None


async def test_list_by_user_pagination(repo_db):
    for i in range(7):
        await repo.create(user_id="u1", kind="host",
                          input_hash=f"h{i}", input_blob={})
        await asyncio.sleep(0.001)

    p1 = await repo.list_by_user("u1", limit=3)
    assert len(p1["items"]) == 3
    assert p1["next_cursor"] is not None

    p2 = await repo.list_by_user("u1", limit=3, cursor=p1["next_cursor"])
    assert len(p2["items"]) == 3
    assert p2["next_cursor"] is not None

    p3 = await repo.list_by_user("u1", limit=3, cursor=p2["next_cursor"])
    assert len(p3["items"]) == 1
    assert p3["next_cursor"] is None

    seen_ids = {it["id"] for page in (p1, p2, p3) for it in page["items"]}
    assert len(seen_ids) == 7


async def test_list_by_user_filters(repo_db):
    h = await repo.create(user_id="u1", kind="host",
                          input_hash="hh", input_blob={})
    c = await repo.create(user_id="u1", kind="composite",
                          input_hash="cc", input_blob={})
    assert {it["id"] for it in (await repo.list_by_user(
        "u1", kind="host"))["items"]} == {h["id"]}
    assert {it["id"] for it in (await repo.list_by_user(
        "u1", kind="composite"))["items"]} == {c["id"]}


async def test_list_by_user_state_filter(repo_db):
    a = await repo.create(user_id="u1", kind="host",
                          input_hash="a", input_blob={})
    await repo.mark_streaming(a["id"])
    await repo.mark_ready(a["id"], batch_id="b")

    b = await repo.create(user_id="u1", kind="host",
                          input_hash="b", input_blob={})
    # b stays pending.

    ready_only = await repo.list_by_user("u1", state="ready")
    assert {it["id"] for it in ready_only["items"]} == {a["id"]}


async def test_list_by_user_scoped_per_user(repo_db):
    a = await repo.create(user_id="u1", kind="host",
                          input_hash="a", input_blob={})
    b = await repo.create(user_id="u2", kind="host",
                          input_hash="b", input_blob={})
    u1 = await repo.list_by_user("u1")
    u2 = await repo.list_by_user("u2")
    assert {it["id"] for it in u1["items"]} == {a["id"]}
    assert {it["id"] for it in u2["items"]} == {b["id"]}


async def test_list_by_user_invalid_filters_raise(repo_db):
    with pytest.raises(ValueError):
        await repo.list_by_user("u1", kind="bogus")
    with pytest.raises(ValueError):
        await repo.list_by_user("u1", state="bogus")


async def test_list_by_user_caps_limit(repo_db):
    for i in range(5):
        await repo.create(user_id="u1", kind="host",
                          input_hash=f"h{i}", input_blob={})
        await asyncio.sleep(0.001)
    out = await repo.list_by_user("u1", limit=10000)
    # cap at 50 (eng-spec §8)
    assert len(out["items"]) == 5  # only 5 exist; cap not stressed
    out = await repo.list_by_user("u1", limit=0)
    # min 1
    assert len(out["items"]) == 1


async def test_list_by_user_stale_cursor_returns_head(repo_db):
    a = await repo.create(user_id="u1", kind="host",
                          input_hash="a", input_blob={})
    out = await repo.list_by_user("u1", cursor="nonexistent-job-id")
    # Stale cursor → reset to head, not 400.
    assert {it["id"] for it in out["items"]} == {a["id"]}


# ── partial unique index — DB-level enforcement ───────────────────────

async def test_indexes_present(repo_db):
    """init_indexes() must create the eng-spec §7 indexes with the
    correct uniqueness + partial-filter shape — name-only checks miss
    cases where the unique flag is dropped (dedupe collapses) or the
    partial filter widens (sweep over-scans)."""
    db = repo_db
    by_name = {ix["name"]: ix async for ix in db.generation_jobs.list_indexes()}

    # Listing index — non-unique, no partial filter.
    assert "user_kind_created" in by_name
    listing = by_name["user_kind_created"]
    assert not listing.get("unique", False)
    assert "partialFilterExpression" not in listing

    # Sweep index — partial on state=streaming.
    assert "state_heartbeat_streaming" in by_name
    sweep = by_name["state_heartbeat_streaming"]
    assert sweep["partialFilterExpression"] == {"state": "streaming"}

    # TTL candidates — partial on terminal-state $in.
    assert "state_updated_terminal" in by_name
    ttl = by_name["state_updated_terminal"]
    assert ttl["partialFilterExpression"] == {
        "state": {"$in": ["ready", "failed", "cancelled"]}
    }

    # Dedupe index — UNIQUE + partial on active states. The unique flag
    # is the load-bearing bit: drop it and create_or_get_active stops
    # collapsing concurrent re-rolls.
    assert "user_input_hash_active_uniq" in by_name
    dedupe = by_name["user_input_hash_active_uniq"]
    assert dedupe["unique"] is True
    assert dedupe["partialFilterExpression"] == {
        "state": {"$in": ["pending", "streaming"]}
    }

    # Recovery scan — non-partial state idx so mark_active_as_failed
    # at startup avoids a COLLSCAN while uvicorn is blocked on bind.
    assert "state_idx" in by_name
    recovery = by_name["state_idx"]
    assert "partialFilterExpression" not in recovery


# ── bulk recovery (JobRunner-owned) ────────────────────────────────────

async def test_mark_active_as_failed_transitions_pending_and_streaming(repo_db):
    """At startup, both pending and streaming are unreachable (in-process
    submit registry was lost) — both transition to failed."""
    a = await repo.create(user_id="u1", kind="host",
                          input_hash="a", input_blob={})
    # b stays pending
    b = await repo.create(user_id="u1", kind="host",
                          input_hash="b", input_blob={})
    await repo.mark_streaming(a["id"])

    # Pre-existing terminal rows must NOT be touched.
    c = await repo.create(user_id="u1", kind="host",
                          input_hash="c", input_blob={})
    await repo.mark_streaming(c["id"])
    await repo.mark_ready(c["id"], batch_id="b")

    n = await repo.mark_active_as_failed(error="restart")
    assert n == 2

    snap_a = await repo.get_by_id("u1", a["id"])
    snap_b = await repo.get_by_id("u1", b["id"])
    snap_c = await repo.get_by_id("u1", c["id"])
    assert snap_a["state"] == "failed"
    assert snap_a["error"] == "restart"
    assert snap_b["state"] == "failed"
    assert snap_c["state"] == "ready"  # untouched


async def test_mark_active_as_failed_empty_returns_zero(repo_db):
    n = await repo.mark_active_as_failed(error="x")
    assert n == 0


async def test_mark_heartbeat_stale_as_failed(repo_db):
    """Streaming rows with heartbeat older than cutoff → failed."""
    from datetime import datetime, timedelta, timezone

    db = repo_db
    a = await repo.create(user_id="u1", kind="host",
                          input_hash="a", input_blob={})
    b = await repo.create(user_id="u1", kind="host",
                          input_hash="b", input_blob={})
    await repo.mark_streaming(a["id"])
    await repo.mark_streaming(b["id"])

    # Backdate a's heartbeat to simulate a stalled worker.
    long_ago = datetime.now(timezone.utc) - timedelta(minutes=30)
    await db.generation_jobs.update_one(
        {"_id": a["id"]}, {"$set": {"heartbeat_at": long_ago}},
    )

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
    n = await repo.mark_heartbeat_stale_as_failed(cutoff)
    assert n == 1

    snap_a = await repo.get_by_id("u1", a["id"])
    snap_b = await repo.get_by_id("u1", b["id"])
    assert snap_a["state"] == "failed"
    assert "heartbeat" in (snap_a["error"] or "")
    assert snap_b["state"] == "streaming"  # fresh heartbeat, untouched


async def test_mark_heartbeat_stale_includes_null_heartbeat(repo_db):
    """A streaming row with no heartbeat ever set is also stale (the worker
    never bumped it)."""
    from datetime import datetime, timedelta, timezone

    db = repo_db
    a = await repo.create(user_id="u1", kind="host",
                          input_hash="a", input_blob={})
    await repo.mark_streaming(a["id"])
    await db.generation_jobs.update_one(
        {"_id": a["id"]}, {"$set": {"heartbeat_at": None}},
    )

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
    n = await repo.mark_heartbeat_stale_as_failed(cutoff)
    assert n == 1


async def test_mark_heartbeat_stale_skips_non_streaming(repo_db):
    """Pending and terminal rows are not touched."""
    from datetime import datetime, timedelta, timezone

    a = await repo.create(user_id="u1", kind="host",
                          input_hash="a", input_blob={})
    # a stays pending
    cutoff = datetime.now(timezone.utc) + timedelta(minutes=5)  # everything stale
    n = await repo.mark_heartbeat_stale_as_failed(cutoff)
    assert n == 0
    snap = await repo.get_by_id("u1", a["id"])
    assert snap["state"] == "pending"


# ── mark_ready_with_lifecycle (step 10) ───────────────────────────────

@pytest_asyncio.fixture
async def lifecycle_dirs(monkeypatch, tmp_path):
    """host_repo.record_batch needs OUTPUTS_DIR + a real file behind each
    storage_key. This fixture redirects config dirs and gives tests a
    helper to seed PNGs."""
    import config
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    examples = tmp_path / "examples"
    saved = outputs / "hosts" / "saved"
    for d in (uploads, outputs, examples, saved):
        d.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(examples))
    yield {"saved": saved}


def _write_png(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 16)


async def test_lifecycle_writes_candidates_and_marks_ready(repo_db, lifecycle_dirs):
    """Variants with real paths land in studio_hosts via record_batch and
    the row's state flips to ready. prev_selected is None on a fresh
    user (no prior committed selection)."""
    saved = lifecycle_dirs["saved"]
    p1 = saved / "host_a_s1.png"; _write_png(p1)
    p2 = saved / "host_b_s1.png"; _write_png(p2)

    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    db = repo_db
    await db.generation_jobs.update_one(
        {"_id": job["id"]},
        {"$set": {
            "state": "streaming",
            "variants": [
                {"image_id": "host_a_s1", "path": str(p1)},
                {"image_id": "host_b_s1", "path": str(p2)},
            ],
        }},
    )

    ok = await repo.mark_ready_with_lifecycle(
        job["id"], user_id="u1", kind="host", batch_id="b1",
    )
    assert ok is True

    snap = await repo.get_by_id("u1", job["id"])
    assert snap["state"] == "ready"
    assert snap["batch_id"] == "b1"
    assert snap["prev_selected_image_id"] is None  # no prior selection

    # studio_hosts has the candidates now (record_batch ran).
    rows = [d async for d in db.studio_hosts.find({"user_id": "u1"})]
    assert len(rows) == 2
    assert {r["image_id"] for r in rows} == {"host_a_s1", "host_b_s1"}
    assert all(r["batch_id"] == "b1" for r in rows)
    assert all(r["status"] == "draft" for r in rows)


async def test_lifecycle_extracts_prev_selected_after_demote(
    repo_db, lifecycle_dirs,
):
    """On a re-roll (a prior 'selected' candidate exists), cleanup_after_
    generate demotes it to is_prev_selected=True, and the lifecycle
    repo extracts that image_id into prev_selected_image_id on the
    generation_jobs row."""
    saved = lifecycle_dirs["saved"]
    p_old = saved / "old.png"; _write_png(p_old)
    p_new = saved / "new.png"; _write_png(p_new)

    from modules.repositories import studio_host_repo

    # Seed a prior selected candidate for step 1-host.
    await studio_host_repo.record_batch(
        "u1", "1-host", [str(p_old)], "old-batch",
    )
    await studio_host_repo.select("u1", "1-host", "old")
    # Sanity: select promoted it.
    pre_state = await studio_host_repo.get_state("u1", "1-host")
    assert pre_state["selected"]["image_id"] == "old"

    # Now run a re-roll lifecycle for a new batch.
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h_reroll", input_blob={})
    db = repo_db
    await db.generation_jobs.update_one(
        {"_id": job["id"]},
        {"$set": {
            "state": "streaming",
            "variants": [{"image_id": "new", "path": str(p_new)}],
        }},
    )

    ok = await repo.mark_ready_with_lifecycle(
        job["id"], user_id="u1", kind="host", batch_id="reroll-b",
    )
    assert ok is True

    snap = await repo.get_by_id("u1", job["id"])
    # cleanup_after_generate demoted 'old' to is_prev_selected=True; the
    # lifecycle pulls that id into the generation_jobs row.
    assert snap["prev_selected_image_id"] == "old"


async def test_lifecycle_empty_variants_still_marks_ready(
    repo_db, lifecycle_dirs,
):
    """No paths in variants → record_batch is skipped (no-op for empty
    list). cleanup still runs (a no-op against empty studio_hosts).
    The state transition still completes."""
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    db = repo_db
    await db.generation_jobs.update_one(
        {"_id": job["id"]},
        {"$set": {
            "state": "streaming",
            "variants": [{"image_id": "v1"}],  # no 'path' key
        }},
    )
    ok = await repo.mark_ready_with_lifecycle(
        job["id"], user_id="u1", kind="host",
    )
    assert ok is True
    snap = await repo.get_by_id("u1", job["id"])
    assert snap["state"] == "ready"
    # batch_id defaults to job_id.
    assert snap["batch_id"] == job["id"]


async def test_lifecycle_blocked_by_concurrent_cancel(
    repo_db, lifecycle_dirs,
):
    """If the row was cancelled before we run, the conditional state
    update at the end returns 0 rows and we report False — without
    overwriting the cancelled state."""
    saved = lifecycle_dirs["saved"]
    p1 = saved / "c.png"; _write_png(p1)
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    await repo.mark_streaming(job["id"])
    db = repo_db
    await db.generation_jobs.update_one(
        {"_id": job["id"]},
        {"$set": {"variants": [{"image_id": "c", "path": str(p1)}]}},
    )
    # User cancels in between.
    await repo.mark_cancelled(job["id"], owner_user_id="u1")

    ok = await repo.mark_ready_with_lifecycle(
        job["id"], user_id="u1", kind="host",
    )
    # Concurrent cancel won — lifecycle saw state != streaming early and
    # returned False without writing.
    assert ok is False
    snap = await repo.get_by_id("u1", job["id"])
    assert snap["state"] == "cancelled"


async def test_lifecycle_unknown_kind_raises(repo_db, lifecycle_dirs):
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    with pytest.raises(ValueError, match="kind must be"):
        await repo.mark_ready_with_lifecycle(
            job["id"], user_id="u1", kind="weird",
        )


async def test_lifecycle_kind_step_mapping(repo_db, lifecycle_dirs):
    """host→1-host, composite→2-composite. Verified by checking which
    step's studio_hosts rows the lifecycle wrote into."""
    saved = lifecycle_dirs["saved"]
    p1 = saved / "x.png"; _write_png(p1)

    j_host = await repo.create(user_id="u1", kind="host",
                               input_hash="h1", input_blob={})
    db = repo_db
    await db.generation_jobs.update_one(
        {"_id": j_host["id"]},
        {"$set": {"state": "streaming",
                  "variants": [{"image_id": "x", "path": str(p1)}]}},
    )
    await repo.mark_ready_with_lifecycle(
        j_host["id"], user_id="u1", kind="host", batch_id="bh",
    )

    p2 = saved / "y.png"; _write_png(p2)
    j_comp = await repo.create(user_id="u1", kind="composite",
                               input_hash="hc", input_blob={})
    await db.generation_jobs.update_one(
        {"_id": j_comp["id"]},
        {"$set": {"state": "streaming",
                  "variants": [{"image_id": "y", "path": str(p2)}]}},
    )
    await repo.mark_ready_with_lifecycle(
        j_comp["id"], user_id="u1", kind="composite", batch_id="bc",
    )

    host_rows = [d async for d in db.studio_hosts.find(
        {"user_id": "u1", "step": "1-host"})]
    comp_rows = [d async for d in db.studio_hosts.find(
        {"user_id": "u1", "step": "2-composite"})]
    assert {r["image_id"] for r in host_rows} == {"x"}
    assert {r["image_id"] for r in comp_rows} == {"y"}
