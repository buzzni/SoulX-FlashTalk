"""Tests for TaskQueue.retry_task — D3A retry-aware primary lineage.

Eng-review 1A: retry_task must stamp `retried_from: <original_task_id>`
on the new entry so the frontend can decide whether the next failure
suggests 재시도 (depth 0) or 수정해서 다시 만들기 (depth ≥ 1).

Post PR-5: TaskQueue persists to Mongo `generation_jobs` instead of a
JSON file. Tests run against an isolated per-test collection in the
test DB so the production singleton is never touched.
"""
from __future__ import annotations

import os
import uuid

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

import config
from modules import db as db_module
from modules import task_queue as task_queue_module


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}_taskqueue"


@pytest_asyncio.fixture
async def isolated_queue(monkeypatch):
    """Fresh TaskQueue against an isolated Mongo collection.

    Per-test collection name (`test_queue_<uuid>`) means parallel tests
    don't interleave, and the production `generation_jobs` collection
    isn't touched.
    """
    monkeypatch.setattr(config, "MONGO_URL", "mongodb://localhost:27017")
    monkeypatch.setattr(config, "DB_NAME", _test_db_name())

    pre = AsyncIOMotorClient("mongodb://localhost:27017", serverSelectionTimeoutMS=2000)
    pre_db = pre[_test_db_name()]
    for c in await pre_db.list_collection_names():
        await pre_db[c].drop()
    pre.close()

    await db_module.init()
    coll_name = f"test_queue_{uuid.uuid4().hex[:8]}"
    q = task_queue_module.TaskQueue(collection_name=coll_name)
    await q._ensure_indexes()
    yield q
    # Cleanup
    try:
        await db_module.get_db()[coll_name].drop()
    except Exception:
        pass
    await db_module.close()


async def _set_status(q, task_id: str, **fields):
    """Helper: directly mutate an entry's status/error in Mongo. Tests
    use this to simulate a finished task without going through the
    worker loop."""
    await q._coll().update_one({"task_id": task_id}, {"$set": fields})


async def _find(q, task_id: str) -> dict:
    entry = await q._coll().find_one({"task_id": task_id})
    assert entry is not None, f"task {task_id} not found"
    return entry


async def test_retry_task_adds_retried_from_to_new_entry(isolated_queue):
    """The new entry's retried_from points back at the original task_id."""
    q = isolated_queue
    await q.enqueue("orig", "generate", {"prompt": "p"}, user_id="u1")
    await _set_status(q, "orig", status="error", error="boom")
    new_id, status = await q.retry_task("orig", requesting_user_id="u1")
    assert status == "ok"
    assert new_id is not None
    new_entry = await _find(q, new_id)
    assert new_entry["retried_from"] == "orig"
    assert new_entry["status"] == "pending"


async def test_retry_task_leaves_original_entry_untouched(isolated_queue):
    """Regression: retry_task must not mutate the original entry — users
    still need to see what failed and what replaced it side by side."""
    q = isolated_queue
    await q.enqueue("orig", "generate", {"prompt": "p"}, user_id="u1")
    await _set_status(q, "orig", status="error", error="boom")
    snapshot_before = await _find(q, "orig")
    await q.retry_task("orig", requesting_user_id="u1")
    original = await _find(q, "orig")
    assert original["status"] == "error"
    assert original["error"] == "boom"
    # PR-5: retried_from is now always present (None on a non-retried
    # entry); the original was never a retry, so it must stay None.
    assert original.get("retried_from") is None
    for k in ("task_id", "user_id", "type", "params", "status", "error"):
        assert original[k] == snapshot_before[k]


async def test_retry_task_chain_two_deep(isolated_queue):
    """A retry of a retry: each link's retried_from points one step back."""
    q = isolated_queue
    await q.enqueue("a", "generate", {"prompt": "p"}, user_id="u1")
    await _set_status(q, "a", status="error")
    new_b, _ = await q.retry_task("a", requesting_user_id="u1")
    await _set_status(q, new_b, status="error")
    new_c, _ = await q.retry_task(new_b, requesting_user_id="u1")
    entry_b = await _find(q, new_b)
    entry_c = await _find(q, new_c)
    assert entry_b["retried_from"] == "a"
    assert entry_c["retried_from"] == new_b


async def test_retry_task_persists_retried_from_across_instances(isolated_queue):
    """The new entry survives a TaskQueue rebind — retried_from is on
    the Mongo doc, not in-memory state."""
    q = isolated_queue
    await q.enqueue("orig", "generate", {"prompt": "p"}, user_id="u1")
    await _set_status(q, "orig", status="error")
    new_id, _ = await q.retry_task("orig", requesting_user_id="u1")

    # Fresh instance against the same collection should see the field.
    q2 = task_queue_module.TaskQueue(collection_name=q._collection_name)
    reloaded = await q2._coll().find_one({"task_id": new_id})
    assert reloaded is not None
    assert reloaded["retried_from"] == "orig"


async def test_retry_task_unfinished_returns_not_finished(isolated_queue):
    """Regression: pending/running tasks remain non-retryable."""
    q = isolated_queue
    await q.enqueue("orig", "generate", {"prompt": "p"}, user_id="u1")
    new_id, status = await q.retry_task("orig", requesting_user_id="u1")
    assert status == "not_finished"
    assert new_id is None
