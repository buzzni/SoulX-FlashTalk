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
