"""Tests for TaskQueue.retry_task — D3A retry-aware primary lineage.

Eng-review 1A: retry_task must stamp `retried_from: <original_task_id>`
on the new entry so the frontend can decide whether the next failure
suggests 재시도 (depth 0) or 수정해서 다시 만들기 (depth ≥ 1).

These tests instantiate a fresh TaskQueue against an isolated JSON file
in tmp_path so the dev `outputs/task_queue.json` is never touched.
"""
from __future__ import annotations

import pytest

from modules import task_queue as task_queue_module


@pytest.fixture
def isolated_queue(tmp_path, monkeypatch):
    """A fresh TaskQueue backed by tmp_path/queue.json.

    The module-level singleton is left alone — these tests construct
    their own instance against an isolated file.
    """
    qfile = tmp_path / "queue.json"
    monkeypatch.setattr(task_queue_module, "QUEUE_FILE", str(qfile))
    return task_queue_module.TaskQueue()


async def test_retry_task_adds_retried_from_to_new_entry(isolated_queue):
    """The new entry's retried_from points back at the original task_id."""
    q = isolated_queue
    await q.enqueue("orig", "generate", {"prompt": "p"}, user_id="u1")
    # Mark it errored so retry_task accepts it.
    async with q._lock:
        q._queue[0]["status"] = "error"
        q._queue[0]["error"] = "boom"
    new_id, status = await q.retry_task("orig", requesting_user_id="u1")
    assert status == "ok"
    assert new_id is not None
    new_entry = next(e for e in q._queue if e["task_id"] == new_id)
    assert new_entry["retried_from"] == "orig"
    assert new_entry["status"] == "pending"


async def test_retry_task_leaves_original_entry_untouched(isolated_queue):
    """Regression: retry_task must not mutate the original entry — users
    still need to see what failed and what replaced it side by side."""
    q = isolated_queue
    await q.enqueue("orig", "generate", {"prompt": "p"}, user_id="u1")
    async with q._lock:
        q._queue[0]["status"] = "error"
        q._queue[0]["error"] = "boom"
    snapshot_before = dict(q._queue[0])
    await q.retry_task("orig", requesting_user_id="u1")
    original = next(e for e in q._queue if e["task_id"] == "orig")
    assert original["status"] == "error"
    assert original["error"] == "boom"
    assert "retried_from" not in original
    # All preserved fields unchanged:
    for k in ("task_id", "user_id", "type", "params", "status", "error"):
        assert original[k] == snapshot_before[k]


async def test_retry_task_chain_two_deep(isolated_queue):
    """A retry of a retry: each link's retried_from points one step back.

    Frontend's depth-walk heuristic only needs one-deep (`retriedFrom != null`),
    but the chain itself must still resolve cleanly when something walks it.
    """
    q = isolated_queue
    await q.enqueue("a", "generate", {"prompt": "p"}, user_id="u1")
    async with q._lock:
        q._queue[0]["status"] = "error"
    new_b, _ = await q.retry_task("a", requesting_user_id="u1")
    # Mark b errored too, then retry it.
    async with q._lock:
        next(e for e in q._queue if e["task_id"] == new_b)["status"] = "error"
    new_c, _ = await q.retry_task(new_b, requesting_user_id="u1")
    entry_b = next(e for e in q._queue if e["task_id"] == new_b)
    entry_c = next(e for e in q._queue if e["task_id"] == new_c)
    assert entry_b["retried_from"] == "a"
    assert entry_c["retried_from"] == new_b


async def test_retry_task_persists_retried_from_to_disk(isolated_queue, tmp_path):
    """The new entry survives a reload — retried_from is JSON-serialized."""
    q = isolated_queue
    await q.enqueue("orig", "generate", {"prompt": "p"}, user_id="u1")
    async with q._lock:
        q._queue[0]["status"] = "error"
    new_id, _ = await q.retry_task("orig", requesting_user_id="u1")

    # Fresh instance reading the same file should see the field.
    q2 = task_queue_module.TaskQueue()
    reloaded = next(e for e in q2._queue if e["task_id"] == new_id)
    assert reloaded["retried_from"] == "orig"


async def test_retry_task_unfinished_returns_not_finished(isolated_queue):
    """Regression: pending/running tasks remain non-retryable. retried_from
    is only stamped on the success path."""
    q = isolated_queue
    await q.enqueue("orig", "generate", {"prompt": "p"}, user_id="u1")
    # Default status is pending — retry should reject.
    new_id, status = await q.retry_task("orig", requesting_user_id="u1")
    assert status == "not_finished"
    assert new_id is None
