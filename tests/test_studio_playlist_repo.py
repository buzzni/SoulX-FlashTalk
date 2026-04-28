"""Tests for studio_playlist_repo: CRUD + name uniqueness + cascade-to-null.

Lane A of the playlist feature (docs/playlist-feature-plan.md). Includes a
covering test for studio_result_repo.clear_playlist_id since the cascade
delete depends on it.
"""
from __future__ import annotations

import os

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

import config
from modules import db as db_module
from modules.repositories import studio_playlist_repo as repo
from modules.repositories import studio_result_repo


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}_playlistrepo"


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


# ── create ─────────────────────────────────────────────────────────


async def test_create_returns_public_shape(repo_db):
    out = await repo.create("u1", name="겨울 컬렉션")
    assert "playlist_id" in out
    assert len(out["playlist_id"]) == 32
    assert out["name"] == "겨울 컬렉션"
    assert out["video_count"] == 0
    assert out["created_at"] is not None
    assert out["updated_at"] == out["created_at"]


async def test_create_strips_whitespace(repo_db):
    out = await repo.create("u1", name="  신상품  ")
    assert out["name"] == "신상품"


async def test_create_rejects_empty_name(repo_db):
    with pytest.raises(ValueError):
        await repo.create("u1", name="   ")


async def test_create_rejects_reserved_korean(repo_db):
    with pytest.raises(repo.ReservedNameError):
        await repo.create("u1", name="미지정")


async def test_create_rejects_reserved_english_casefold(repo_db):
    with pytest.raises(repo.ReservedNameError):
        await repo.create("u1", name="UNASSIGNED")


async def test_create_dup_name_raises(repo_db):
    await repo.create("u1", name="겨울 컬렉션")
    with pytest.raises(repo.DuplicateNameError):
        await repo.create("u1", name="겨울 컬렉션")


async def test_create_dup_normalized_raises_on_casefold(repo_db):
    await repo.create("u1", name="Winter")
    with pytest.raises(repo.DuplicateNameError):
        await repo.create("u1", name="WINTER")


async def test_create_dup_across_users_ok(repo_db):
    a = await repo.create("alice", name="Winter")
    b = await repo.create("bob", name="Winter")
    assert a["playlist_id"] != b["playlist_id"]


# ── exists ─────────────────────────────────────────────────────────


async def test_exists_true_for_owned(repo_db):
    out = await repo.create("u1", name="x")
    assert await repo.exists("u1", out["playlist_id"]) is True


async def test_exists_false_for_missing(repo_db):
    assert await repo.exists("u1", "deadbeef" * 4) is False


async def test_exists_false_cross_user(repo_db):
    out = await repo.create("alice", name="x")
    assert await repo.exists("bob", out["playlist_id"]) is False


# ── get ────────────────────────────────────────────────────────────


async def test_get_returns_doc(repo_db):
    out = await repo.create("u1", name="x")
    doc = await repo.get("u1", out["playlist_id"])
    assert doc is not None
    assert doc["name"] == "x"


async def test_get_returns_none_for_missing(repo_db):
    assert await repo.get("u1", "deadbeef" * 4) is None


async def test_get_returns_none_cross_user(repo_db):
    out = await repo.create("alice", name="x")
    assert await repo.get("bob", out["playlist_id"]) is None


# ── list_for_user ─────────────────────────────────────────────────


async def test_list_for_user_returns_video_counts(repo_db):
    db = repo_db
    p1 = await repo.create("u1", name="A")
    p2 = await repo.create("u1", name="B")
    docs = [
        {"user_id": "u1", "task_id": "t0", "status": "completed", "playlist_id": p1["playlist_id"]},
        {"user_id": "u1", "task_id": "t1", "status": "completed", "playlist_id": p1["playlist_id"]},
        {"user_id": "u1", "task_id": "t2", "status": "completed", "playlist_id": p2["playlist_id"]},
        {"user_id": "u1", "task_id": "t3", "status": "completed", "playlist_id": None},
    ]
    await db.studio_results.insert_many(docs)
    listed = await repo.list_for_user("u1")
    by_id = {p["playlist_id"]: p for p in listed}
    assert by_id[p1["playlist_id"]]["video_count"] == 2
    assert by_id[p2["playlist_id"]]["video_count"] == 1


async def test_list_for_user_excludes_other_users(repo_db):
    await repo.create("alice", name="x")
    await repo.create("bob", name="y")
    items = await repo.list_for_user("alice")
    assert len(items) == 1
    assert items[0]["name"] == "x"


async def test_list_for_user_counts_all_terminal_statuses(repo_db):
    """Plan decision #21 (results-page-overhaul): video_count covers all
    terminal rows (completed/error/cancelled), not only completed. This
    keeps playlist chip counts aligned with status filter chip totals on
    /results — when a user scopes to a playlist, summing per-status counts
    matches the playlist's number."""
    db = repo_db
    p = await repo.create("u1", name="A")
    pid = p["playlist_id"]
    docs = [
        {"user_id": "u1", "task_id": "t0", "status": "completed", "playlist_id": pid},
        {"user_id": "u1", "task_id": "t1", "status": "error", "playlist_id": pid},
        {"user_id": "u1", "task_id": "t2", "status": "cancelled", "playlist_id": pid},
        {"user_id": "u1", "task_id": "t3", "status": "running", "playlist_id": pid},  # excluded
        {"user_id": "u1", "task_id": "t4", "status": "pending", "playlist_id": pid},  # excluded
    ]
    await db.studio_results.insert_many(docs)
    listed = await repo.list_for_user("u1")
    assert listed[0]["video_count"] == 3  # completed + error + cancelled, not running/pending


async def test_list_for_user_empty(repo_db):
    assert await repo.list_for_user("ghost") == []


# ── rename ─────────────────────────────────────────────────────────


async def test_rename_updates_name(repo_db):
    out = await repo.create("u1", name="old")
    renamed = await repo.rename("u1", out["playlist_id"], name="new")
    assert renamed is not None
    assert renamed["name"] == "new"
    fresh = await repo.get("u1", out["playlist_id"])
    assert fresh["name"] == "new"


async def test_rename_frees_old_normalized(repo_db):
    p = await repo.create("u1", name="A")
    await repo.rename("u1", p["playlist_id"], name="B")
    new = await repo.create("u1", name="A")
    assert new["name"] == "A"


async def test_rename_dup_raises(repo_db):
    a = await repo.create("u1", name="A")
    await repo.create("u1", name="B")
    with pytest.raises(repo.DuplicateNameError):
        await repo.rename("u1", a["playlist_id"], name="B")


async def test_rename_reserved_raises(repo_db):
    p = await repo.create("u1", name="x")
    with pytest.raises(repo.ReservedNameError):
        await repo.rename("u1", p["playlist_id"], name="미지정")


async def test_rename_empty_raises(repo_db):
    p = await repo.create("u1", name="x")
    with pytest.raises(ValueError):
        await repo.rename("u1", p["playlist_id"], name="   ")


async def test_rename_missing_returns_none(repo_db):
    assert await repo.rename("u1", "deadbeef" * 4, name="x") is None


async def test_rename_cross_user_returns_none(repo_db):
    p = await repo.create("alice", name="x")
    assert await repo.rename("bob", p["playlist_id"], name="y") is None


# ── delete (cascade) ─────────────────────────────────────────────


async def test_delete_drops_row(repo_db):
    p = await repo.create("u1", name="x")
    ok = await repo.delete("u1", p["playlist_id"])
    assert ok is True
    assert await repo.get("u1", p["playlist_id"]) is None


async def test_delete_missing_returns_false(repo_db):
    assert await repo.delete("u1", "deadbeef" * 4) is False


async def test_delete_cross_user_returns_false(repo_db):
    p = await repo.create("alice", name="x")
    ok = await repo.delete("bob", p["playlist_id"])
    assert ok is False
    assert await repo.exists("alice", p["playlist_id"]) is True


async def test_delete_cascades_videos_to_null(repo_db):
    db = repo_db
    p = await repo.create("u1", name="x")
    pid = p["playlist_id"]
    docs = [
        {"user_id": "u1", "task_id": f"t{i}", "status": "completed", "playlist_id": pid}
        for i in range(3)
    ]
    await db.studio_results.insert_many(docs)
    await repo.delete("u1", pid)
    rows = [d async for d in db.studio_results.find({"user_id": "u1"})]
    assert len(rows) == 3
    assert all(r["playlist_id"] is None for r in rows)


async def test_delete_does_not_touch_other_users(repo_db):
    db = repo_db
    a = await repo.create("alice", name="x")
    b = await repo.create("bob", name="x")
    await db.studio_results.insert_many([
        {"user_id": "alice", "task_id": "t1", "status": "completed", "playlist_id": a["playlist_id"]},
        {"user_id": "bob", "task_id": "t2", "status": "completed", "playlist_id": b["playlist_id"]},
    ])
    await repo.delete("alice", a["playlist_id"])
    bob_video = await db.studio_results.find_one({"user_id": "bob", "task_id": "t2"})
    assert bob_video["playlist_id"] == b["playlist_id"]
    assert await repo.exists("bob", b["playlist_id"]) is True


# ── count_for_user ───────────────────────────────────────────────


async def test_count_for_user(repo_db):
    await repo.create("u1", name="A")
    await repo.create("u1", name="B")
    await repo.create("u1", name="C")
    await repo.create("u2", name="X")
    assert await repo.count_for_user("u1") == 3
    assert await repo.count_for_user("u2") == 1
    assert await repo.count_for_user("ghost") == 0


# ── unassigned_count ─────────────────────────────────────────────


async def test_unassigned_count_includes_null_and_missing(repo_db):
    """Plan decision #21: counts all terminal rows (completed/error/cancelled)
    where playlist_id is null or absent. Aligned with list_for_user video_count."""
    db = repo_db
    p = await repo.create("u1", name="A")
    docs = [
        {"user_id": "u1", "task_id": "t1", "status": "completed", "playlist_id": None},
        {"user_id": "u1", "task_id": "t2", "status": "completed", "playlist_id": None},
        {"user_id": "u1", "task_id": "t3", "status": "completed"},  # field missing
        {"user_id": "u1", "task_id": "t4", "status": "completed", "playlist_id": p["playlist_id"]},  # in playlist
        {"user_id": "u1", "task_id": "t5", "status": "error", "playlist_id": None},      # NEW: counted
        {"user_id": "u1", "task_id": "t6", "status": "cancelled", "playlist_id": None},  # NEW: counted
        {"user_id": "u1", "task_id": "t7", "status": "running", "playlist_id": None},    # excluded
    ]
    await db.studio_results.insert_many(docs)
    # 3 completed unassigned + 1 error unassigned + 1 cancelled unassigned = 5
    assert await repo.unassigned_count("u1") == 5


async def test_unassigned_count_per_user(repo_db):
    db = repo_db
    await db.studio_results.insert_one({
        "user_id": "alice", "task_id": "t1", "status": "completed", "playlist_id": None,
    })
    assert await repo.unassigned_count("alice") == 1
    assert await repo.unassigned_count("bob") == 0


# ── studio_result_repo.clear_playlist_id ─────────────────────────


async def test_clear_playlist_id_only_matches_target(repo_db):
    db = repo_db
    p1 = await repo.create("u1", name="A")
    p2 = await repo.create("u1", name="B")
    await db.studio_results.insert_many([
        {"user_id": "u1", "task_id": "t1", "status": "completed", "playlist_id": p1["playlist_id"]},
        {"user_id": "u1", "task_id": "t2", "status": "completed", "playlist_id": p2["playlist_id"]},
    ])
    n = await studio_result_repo.clear_playlist_id("u1", p1["playlist_id"])
    assert n == 1
    t1 = await db.studio_results.find_one({"task_id": "t1"})
    t2 = await db.studio_results.find_one({"task_id": "t2"})
    assert t1["playlist_id"] is None
    assert t2["playlist_id"] == p2["playlist_id"]


async def test_clear_playlist_id_owner_scoped(repo_db):
    db = repo_db
    a = await repo.create("alice", name="A")
    pid = a["playlist_id"]
    await db.studio_results.insert_many([
        {"user_id": "alice", "task_id": "t1", "status": "completed", "playlist_id": pid},
        {"user_id": "bob", "task_id": "t2", "status": "completed", "playlist_id": pid},
    ])
    n = await studio_result_repo.clear_playlist_id("alice", pid)
    assert n == 1
    bob_row = await db.studio_results.find_one({"user_id": "bob", "task_id": "t2"})
    assert bob_row["playlist_id"] == pid


async def test_clear_playlist_id_no_match_returns_zero(repo_db):
    n = await studio_result_repo.clear_playlist_id("u1", "deadbeef" * 4)
    assert n == 0
