"""Tests for studio_result_repo: upsert, get, list_completed, delete,
public find_by_task_id, user_id scoping."""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

import config
from modules import db as db_module
from modules.repositories import studio_result_repo as repo


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}_resultrepo"


@pytest_asyncio.fixture
async def repo_db(monkeypatch):
    monkeypatch.setattr(config, "MONGO_URL", "mongodb://localhost:27017")
    monkeypatch.setattr(config, "DB_NAME", _test_db_name())

    pre = AsyncIOMotorClient("mongodb://localhost:27017", serverSelectionTimeoutMS=2000)
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


def _manifest(task_id: str, *, status: str = "completed",
              completed_at: Optional[datetime] = None) -> dict:  # type: ignore[name-defined]
    base = {
        "task_id": task_id,
        "type": "generate",
        "status": status,
        "video_storage_key": f"outputs/res_{task_id}.mp4",
        "video_bytes": 1234,
        "generation_time_sec": 60.5,
        "params": {"prompt": "p", "seed": 42},
        "meta": {"host": {"storage_key": "outputs/hosts/saved/h.png"}},
    }
    if completed_at is not None:
        base["completed_at"] = completed_at
    return base


from typing import Optional  # noqa: E402  (use after function for clarity)


# ── upsert + get ──

async def test_upsert_creates_new_row(repo_db):
    await repo.upsert("u1", _manifest("t1"))
    doc = await repo.get("u1", "t1")
    assert doc is not None
    assert doc["task_id"] == "t1"
    assert doc["status"] == "completed"
    assert doc["video_bytes"] == 1234


async def test_upsert_updates_existing(repo_db):
    await repo.upsert("u1", _manifest("t1", status="running"))
    m2 = _manifest("t1", status="completed")
    m2["video_bytes"] = 9999
    await repo.upsert("u1", m2)
    doc = await repo.get("u1", "t1")
    assert doc["status"] == "completed"
    assert doc["video_bytes"] == 9999


async def test_upsert_requires_user_id(repo_db):
    with pytest.raises(ValueError):
        await repo.upsert("", _manifest("t1"))


async def test_upsert_requires_task_id(repo_db):
    bad = _manifest("x")
    bad.pop("task_id")
    with pytest.raises(ValueError):
        await repo.upsert("u1", bad)


# ── get ──

async def test_get_returns_none_for_missing(repo_db):
    assert await repo.get("u1", "ghost") is None


async def test_get_strips_internal_fields(repo_db):
    await repo.upsert("u1", _manifest("t1"))
    doc = await repo.get("u1", "t1")
    assert "_id" not in doc
    assert "_imported_at" not in doc


# ── list_completed ──

async def test_list_completed_newest_first(repo_db):
    base = datetime(2026, 4, 25, tzinfo=timezone.utc)
    for i in range(3):
        await repo.upsert("u1", _manifest(f"t{i}",
                                            completed_at=base + timedelta(hours=i)))
    items = await repo.list_completed("u1")
    assert [d["task_id"] for d in items] == ["t2", "t1", "t0"]


async def test_list_completed_excludes_other_status(repo_db):
    await repo.upsert("u1", _manifest("done",   status="completed"))
    await repo.upsert("u1", _manifest("running", status="running"))
    await repo.upsert("u1", _manifest("failed", status="failed"))
    items = await repo.list_completed("u1")
    assert [d["task_id"] for d in items] == ["done"]


async def test_list_completed_respects_limit(repo_db):
    for i in range(5):
        await repo.upsert("u1", _manifest(f"t{i}",
                                            completed_at=datetime(2026, 4, 25, tzinfo=timezone.utc) + timedelta(seconds=i)))
    items = await repo.list_completed("u1", limit=2)
    assert len(items) == 2


# ── user_id scoping ──

async def test_user_id_scoping_isolates_users(repo_db):
    await repo.upsert("alice", _manifest("a1"))
    await repo.upsert("bob",   _manifest("b1"))
    assert await repo.get("alice", "a1") is not None
    assert await repo.get("alice", "b1") is None  # alice can't see bob's row
    assert await repo.get("bob", "b1") is not None
    items_a = await repo.list_completed("alice")
    assert [d["task_id"] for d in items_a] == ["a1"]


# ── find_by_task_id (public, no user filter) ──

async def test_find_by_task_id_ignores_user(repo_db):
    """Public /api/videos/{task_id} needs to resolve any task without auth."""
    await repo.upsert("alice", _manifest("public_t"))
    doc = await repo.find_by_task_id("public_t")
    assert doc is not None
    assert doc["task_id"] == "public_t"
    assert "user_id" in doc  # exposed in response payload


async def test_find_by_task_id_missing(repo_db):
    assert await repo.find_by_task_id("ghost") is None


# ── list_completed playlist_id filter (Lane B/C) ──


async def test_list_completed_filter_by_playlist_id(repo_db):
    from modules.repositories import studio_playlist_repo
    p_a = await studio_playlist_repo.create("u1", name="A")
    p_b = await studio_playlist_repo.create("u1", name="B")
    await repo.upsert("u1", _manifest("t1"))
    await repo.upsert("u1", _manifest("t2"))
    await repo.upsert("u1", _manifest("t3"))
    await repo.set_playlist("u1", "t1", p_a["playlist_id"])
    await repo.set_playlist("u1", "t2", p_b["playlist_id"])
    items = await repo.list_completed("u1", playlist_id=p_a["playlist_id"])
    assert [d["task_id"] for d in items] == ["t1"]


async def test_list_completed_filter_unassigned(repo_db):
    from modules.repositories import studio_playlist_repo
    p = await studio_playlist_repo.create("u1", name="A")
    await repo.upsert("u1", _manifest("t1"))  # missing field → unassigned
    await repo.upsert("u1", _manifest("t2"))
    await repo.set_playlist("u1", "t2", p["playlist_id"])
    items = await repo.list_completed("u1", playlist_id="unassigned")
    assert [d["task_id"] for d in items] == ["t1"]


async def test_list_completed_filter_unknown_returns_empty(repo_db):
    """Plan decision #12: stale id → 200 [], not 404."""
    await repo.upsert("u1", _manifest("t1"))
    items = await repo.list_completed("u1", playlist_id="f" * 32)
    assert items == []


# ── set_playlist (Lane B/C) ──


async def test_set_playlist_happy(repo_db):
    from modules.repositories import studio_playlist_repo
    p = await studio_playlist_repo.create("u1", name="A")
    await repo.upsert("u1", _manifest("t1"))
    out = await repo.set_playlist("u1", "t1", p["playlist_id"])
    assert out is not None
    assert out["playlist_id"] == p["playlist_id"]
    fresh = await repo.get("u1", "t1")
    assert fresh["playlist_id"] == p["playlist_id"]


async def test_set_playlist_to_none_unassigns(repo_db):
    from modules.repositories import studio_playlist_repo
    p = await studio_playlist_repo.create("u1", name="A")
    await repo.upsert("u1", _manifest("t1"))
    await repo.set_playlist("u1", "t1", p["playlist_id"])
    out = await repo.set_playlist("u1", "t1", None)
    assert out["playlist_id"] is None


async def test_set_playlist_unknown_target_raises(repo_db):
    await repo.upsert("u1", _manifest("t1"))
    with pytest.raises(LookupError):
        await repo.set_playlist("u1", "t1", "f" * 32)


async def test_set_playlist_cross_user_target_raises(repo_db):
    from modules.repositories import studio_playlist_repo
    alice_p = await studio_playlist_repo.create("alice", name="A")
    await repo.upsert("bob", _manifest("t1"))
    with pytest.raises(LookupError):
        await repo.set_playlist("bob", "t1", alice_p["playlist_id"])


async def test_set_playlist_missing_result_returns_none(repo_db):
    from modules.repositories import studio_playlist_repo
    p = await studio_playlist_repo.create("u1", name="A")
    out = await repo.set_playlist("u1", "ghost", p["playlist_id"])
    assert out is None


# ── upsert silent-coerce on stale playlist_id (Lane C, plan §9) ──


async def test_upsert_keeps_valid_playlist_id(repo_db):
    from modules.repositories import studio_playlist_repo
    p = await studio_playlist_repo.create("u1", name="A")
    m = _manifest("t1")
    m["playlist_id"] = p["playlist_id"]
    await repo.upsert("u1", m)
    fresh = await repo.get("u1", "t1")
    assert fresh["playlist_id"] == p["playlist_id"]


async def test_upsert_coerces_unknown_playlist_id_to_null(repo_db):
    """Worker race recovery: user deletes playlist mid-render → coerce, not raise."""
    m = _manifest("t1")
    m["playlist_id"] = "f" * 32
    await repo.upsert("u1", m)
    fresh = await repo.get("u1", "t1")
    assert fresh["playlist_id"] is None


async def test_upsert_coerces_cross_user_playlist_id_to_null(repo_db):
    from modules.repositories import studio_playlist_repo
    alice_p = await studio_playlist_repo.create("alice", name="A")
    m = _manifest("bob_task")
    m["playlist_id"] = alice_p["playlist_id"]
    await repo.upsert("bob", m)
    fresh = await repo.get("bob", "bob_task")
    assert fresh["playlist_id"] is None


async def test_upsert_null_playlist_id_passthrough(repo_db):
    m = _manifest("t1")
    m["playlist_id"] = None
    await repo.upsert("u1", m)
    fresh = await repo.get("u1", "t1")
    assert fresh.get("playlist_id") is None


# ── Queue handler forwards playlist_id (Lane D) ──


async def test_queue_generate_handler_forwards_playlist_id(monkeypatch, repo_db):
    """The queue handler unpacks params and calls generate_video_task by name.
    We monkeypatch the task fn and assert playlist_id makes the round trip."""
    import app as app_module
    captured: dict = {}

    async def _fake(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(app_module, "generate_video_task", _fake)
    await app_module._queue_generate_handler(
        task_id="t1", user_id="u1",
        host_image="h.png", audio_path="a.wav",
        audio_source_label="upload", prompt="p", seed=1,
        cpu_offload=False, playlist_id="abc" + "0" * 29,
    )
    assert captured["playlist_id"] == "abc" + "0" * 29


async def test_queue_conversation_handler_forwards_playlist_id(monkeypatch, repo_db):
    import app as app_module
    captured: dict = {}

    async def _fake(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(app_module, "generate_conversation_task", _fake)
    await app_module._queue_conversation_handler(
        task_id="t1", user_id="u1",
        dialog_data={}, layout="split", prompt="p", seed=1,
        cpu_offload=False, playlist_id="def" + "0" * 29,
    )
    assert captured["playlist_id"] == "def" + "0" * 29


# ── delete ──

async def test_delete_owner_only(repo_db):
    await repo.upsert("alice", _manifest("a1"))
    assert await repo.delete("bob", "a1") is False  # bob doesn't own it
    assert await repo.get("alice", "a1") is not None  # still there
    assert await repo.delete("alice", "a1") is True
    assert await repo.get("alice", "a1") is None


async def test_delete_missing_returns_false(repo_db):
    assert await repo.delete("u1", "ghost") is False


# ── partial unique on (user_id, task_id) ──

async def test_unique_user_task_index_blocks_duplicate(repo_db):
    """Test the index — direct insert (not upsert) fails on duplicate."""
    db = repo_db
    await db.studio_results.insert_one({
        "user_id": "u1", "task_id": "t1", "status": "completed"
    })
    from pymongo.errors import DuplicateKeyError
    with pytest.raises(DuplicateKeyError):
        await db.studio_results.insert_one({
            "user_id": "u1", "task_id": "t1", "status": "completed"
        })


# ── count helper ──

async def test_count_for_user(repo_db):
    assert await repo.count_for_user("u1") == 0
    await repo.upsert("u1", _manifest("t1"))
    await repo.upsert("u1", _manifest("t2"))
    await repo.upsert("u2", _manifest("u2t1"))
    assert await repo.count_for_user("u1") == 2
    assert await repo.count_for_user("u2") == 1


# ── _map_public_error (decision #22) ──

@pytest.mark.parametrize("raw, expected_substring", [
    ("CUDA out of memory", "서버가 바쁜"),
    ("Some prefix - CUDA OOM detected", "서버가 바쁜"),
    ("audio file not found at /tmp/x.wav", "음성 파일을 찾을 수 없"),
    ("audio is too long: 60s exceeds 30s", "음성 파일이 너무 길"),
    ("host_image is missing", "쇼호스트 이미지를 찾을 수 없"),
    ("Output mp4 not generated", "영상 생성에 실패"),
    ("operation timeout after 600s", "처리 시간이 너무 오래"),
    ("cancelled by user", "사용자가 취소"),
    ("validation failed: empty prompt", "입력 값이 올바르지 않"),
])
def test_map_public_error_pattern_matches(raw, expected_substring):
    msg = repo._map_public_error(raw)
    assert expected_substring in msg, f"raw={raw!r} → {msg!r}"


def test_map_public_error_fallback_for_none():
    assert repo._map_public_error(None) == "알 수 없는 이유로 실패했어요."


def test_map_public_error_fallback_for_empty():
    assert repo._map_public_error("") == "알 수 없는 이유로 실패했어요."


def test_map_public_error_fallback_for_unknown():
    assert repo._map_public_error("entirely random text") == "알 수 없는 이유로 실패했어요."


def test_map_public_error_strips_paths():
    """Even when a known pattern matches, the returned text must NOT contain
    file paths or stack-trace fragments from the raw input. The mapping
    table is the security boundary."""
    raw = "CUDA out of memory at /opt/home/jack/secret/leak.py:123"
    msg = repo._map_public_error(raw)
    assert "/opt" not in msg
    assert "leak.py" not in msg


# ── persist_terminal_failure (decision #20) ──

async def test_persist_terminal_failure_writes_error_row(repo_db):
    await repo.persist_terminal_failure(
        user_id="u1",
        task_id="failed_t1",
        type="generate",
        status="error",
        error="CUDA out of memory",
        params={"prompt": "p", "seed": 42},
        playlist_id=None,
    )
    doc = await repo.get("u1", "failed_t1")
    assert doc is not None
    assert doc["status"] == "error"
    assert doc["type"] == "generate"
    assert doc["error"] == "CUDA out of memory"  # raw preserved
    assert "서버가 바쁜" in doc["public_error"]    # mapped
    assert doc["completed_at"] is not None        # always set per decision #19
    assert doc["params"] == {"prompt": "p", "seed": 42}
    assert doc["video_path"] is None
    assert doc["video_bytes"] == 0


async def test_persist_terminal_failure_writes_cancelled_row(repo_db):
    await repo.persist_terminal_failure(
        user_id="u1",
        task_id="cancel_t1",
        type="generate",
        status="cancelled",
        error=None,
        params={},
    )
    doc = await repo.get("u1", "cancel_t1")
    assert doc["status"] == "cancelled"
    assert doc["error"] is None
    assert doc["public_error"] == "사용자가 취소했어요."
    assert doc["completed_at"] is not None


async def test_persist_terminal_failure_rejects_invalid_status(repo_db):
    with pytest.raises(ValueError, match="error.*cancelled"):
        await repo.persist_terminal_failure(
            user_id="u1", task_id="t1", type="generate",
            status="completed",
            error=None, params={},
        )


async def test_persist_terminal_failure_swallows_db_errors(repo_db):
    """If the manifest write fails (e.g., Mongo down mid-cancel), the
    function must NOT propagate — original error/cancel path keeps working."""
    # Force upsert failure by passing an oversized doc that violates BSON limits.
    # Easier path: monkey-pass user_id="" which makes upsert raise ValueError;
    # persist_terminal_failure should catch and log without re-raising.
    await repo.persist_terminal_failure(
        user_id="",  # invalid → upsert raises → persist catches
        task_id="t1",
        type="generate",
        status="error",
        error="boom",
        params={},
    )
    # No assertion needed — test passes if no exception escapes.


async def test_persist_terminal_failure_preserves_playlist_id(repo_db):
    from modules.repositories import studio_playlist_repo
    p = await studio_playlist_repo.create("u1", name="A")
    await repo.persist_terminal_failure(
        user_id="u1", task_id="failed_in_p", type="generate",
        status="error", error="boom",
        params={}, playlist_id=p["playlist_id"],
    )
    doc = await repo.get("u1", "failed_in_p")
    assert doc["playlist_id"] == p["playlist_id"]


# ── list_for_user (replaces list_completed) ──

async def test_list_for_user_default_includes_all_statuses(repo_db):
    await repo.upsert("u1", _manifest("done"))
    await repo.persist_terminal_failure(
        user_id="u1", task_id="failed", type="generate",
        status="error", error="x", params={},
    )
    await repo.persist_terminal_failure(
        user_id="u1", task_id="cancelled", type="generate",
        status="cancelled", error=None, params={},
    )
    rows, total = await repo.list_for_user("u1")
    assert total == 3
    assert {r["task_id"] for r in rows} == {"done", "failed", "cancelled"}


async def test_list_for_user_filters_by_single_status(repo_db):
    await repo.upsert("u1", _manifest("done"))
    await repo.persist_terminal_failure(
        user_id="u1", task_id="failed", type="generate",
        status="error", error="x", params={},
    )
    rows, total = await repo.list_for_user("u1", statuses=["error"])
    assert total == 1
    assert rows[0]["task_id"] == "failed"


async def test_list_for_user_pagination(repo_db):
    base = datetime(2026, 4, 25, tzinfo=timezone.utc)
    for i in range(5):
        await repo.upsert("u1", _manifest(f"t{i}",
                                            completed_at=base + timedelta(seconds=i)))
    # Page 1: 2 newest.
    rows, total = await repo.list_for_user("u1", offset=0, limit=2)
    assert total == 5
    assert [r["task_id"] for r in rows] == ["t4", "t3"]
    # Page 2.
    rows, total = await repo.list_for_user("u1", offset=2, limit=2)
    assert [r["task_id"] for r in rows] == ["t2", "t1"]
    # Page 3 (last, partial).
    rows, total = await repo.list_for_user("u1", offset=4, limit=2)
    assert [r["task_id"] for r in rows] == ["t0"]


async def test_list_for_user_beyond_last_page_returns_empty(repo_db):
    """Plan §10 failure mode: stale page after deletion returns 200 [] with
    correct total. Frontend snaps to last valid page on this signal."""
    await repo.upsert("u1", _manifest("t1"))
    rows, total = await repo.list_for_user("u1", offset=100, limit=24)
    assert rows == []
    assert total == 1


async def test_list_for_user_empty_result_set(repo_db):
    rows, total = await repo.list_for_user("ghost_user")
    assert rows == []
    assert total == 0


async def test_list_for_user_combines_status_and_playlist(repo_db):
    from modules.repositories import studio_playlist_repo
    p = await studio_playlist_repo.create("u1", name="A")
    # Completed in playlist:
    m1 = _manifest("ok_in_p")
    m1["playlist_id"] = p["playlist_id"]
    await repo.upsert("u1", m1)
    # Error in playlist:
    await repo.persist_terminal_failure(
        user_id="u1", task_id="err_in_p", type="generate",
        status="error", error="x", params={},
        playlist_id=p["playlist_id"],
    )
    # Error not in playlist:
    await repo.persist_terminal_failure(
        user_id="u1", task_id="err_unassigned", type="generate",
        status="error", error="x", params={},
    )
    # Filter status=error AND playlist=p → only err_in_p.
    rows, total = await repo.list_for_user(
        "u1", statuses=["error"], playlist_id=p["playlist_id"],
    )
    assert total == 1
    assert rows[0]["task_id"] == "err_in_p"


async def test_list_for_user_clamps_limit(repo_db):
    """limit must be 1..100. Repo clamps defensively."""
    for i in range(3):
        await repo.upsert("u1", _manifest(f"t{i}"))
    # Over-large → clamped to 100 (still returns all 3).
    rows, _ = await repo.list_for_user("u1", limit=999)
    assert len(rows) == 3
    # Zero → clamped to 1.
    rows, _ = await repo.list_for_user("u1", limit=0)
    assert len(rows) == 1


# ── counts_for_user (decision #14) ──

async def test_counts_for_user_sum_invariant(repo_db):
    """all == completed + error + cancelled — across all queries."""
    await repo.upsert("u1", _manifest("c1"))
    await repo.upsert("u1", _manifest("c2"))
    await repo.persist_terminal_failure(
        user_id="u1", task_id="e1", type="generate",
        status="error", error="x", params={},
    )
    await repo.persist_terminal_failure(
        user_id="u1", task_id="x1", type="generate",
        status="cancelled", error=None, params={},
    )
    counts = await repo.counts_for_user("u1")
    assert counts == {"all": 4, "completed": 2, "error": 1, "cancelled": 1}
    assert counts["all"] == counts["completed"] + counts["error"] + counts["cancelled"]


async def test_counts_for_user_empty(repo_db):
    counts = await repo.counts_for_user("ghost")
    assert counts == {"all": 0, "completed": 0, "error": 0, "cancelled": 0}


async def test_counts_for_user_scoped_by_playlist(repo_db):
    from modules.repositories import studio_playlist_repo
    p = await studio_playlist_repo.create("u1", name="A")
    # 1 completed in p, 1 cancelled in p, 1 completed unassigned.
    m1 = _manifest("c_in_p"); m1["playlist_id"] = p["playlist_id"]
    await repo.upsert("u1", m1)
    await repo.upsert("u1", _manifest("c_unassigned"))
    await repo.persist_terminal_failure(
        user_id="u1", task_id="cancelled_in_p", type="generate",
        status="cancelled", error=None, params={},
        playlist_id=p["playlist_id"],
    )
    counts = await repo.counts_for_user("u1", playlist_id=p["playlist_id"])
    assert counts == {"all": 2, "completed": 1, "error": 0, "cancelled": 1}


async def test_counts_for_user_scoped_unassigned(repo_db):
    from modules.repositories import studio_playlist_repo
    p = await studio_playlist_repo.create("u1", name="A")
    m1 = _manifest("c_in_p"); m1["playlist_id"] = p["playlist_id"]
    await repo.upsert("u1", m1)
    await repo.upsert("u1", _manifest("c_unassigned"))
    counts = await repo.counts_for_user("u1", playlist_id="unassigned")
    assert counts["all"] == 1
    assert counts["completed"] == 1


async def test_counts_for_user_ignores_other_users(repo_db):
    await repo.upsert("alice", _manifest("a1"))
    await repo.upsert("bob", _manifest("b1"))
    counts = await repo.counts_for_user("alice")
    assert counts["all"] == 1


# ── list_completed thin wrapper preserves backward compat (regression) ──

async def test_list_completed_wrapper_unchanged_behavior(repo_db):
    """Iron rule: existing /api/history callers using list_completed must
    still receive only completed rows. Persistence write-path must not
    leak error/cancelled rows into legacy callers."""
    await repo.upsert("u1", _manifest("done"))
    await repo.persist_terminal_failure(
        user_id="u1", task_id="failed", type="generate",
        status="error", error="x", params={},
    )
    rows = await repo.list_completed("u1")
    assert [r["task_id"] for r in rows] == ["done"]
