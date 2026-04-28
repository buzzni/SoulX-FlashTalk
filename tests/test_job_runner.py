"""Tests for JobRunner: handler dispatch, recovery, sweep, graceful shutdown."""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

import config
from modules import db as db_module
from modules import job_runner as job_runner_module
from modules.job_runner import JobRunner, assert_single_process_or_raise
from modules.repositories import studio_jobs_repo as repo


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}_jobrunner"


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


# Make conftest skip its monkey-patching for this module too.
@pytest.fixture(autouse=True)
def _bypass_studio_auth_skip():
    # The conftest fixture already skips when mod_name in (...). This
    # autouse fixture is here for documentation; the actual skip is in
    # conftest.py.
    pass


async def _wait_terminal(job_id: str, timeout: float = 5.0) -> dict:
    """Poll until the row reaches a terminal state."""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        snap = await repo.get_by_id_internal(job_id)
        if snap and snap["state"] in repo.TERMINAL_STATES:
            return snap
        await asyncio.sleep(0.01)
    snap = await repo.get_by_id_internal(job_id)
    raise AssertionError(
        f"job {job_id} did not reach terminal in {timeout}s, last={snap}"
    )


async def _wait_streaming(job_id: str, timeout: float = 5.0) -> dict:
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        snap = await repo.get_by_id_internal(job_id)
        if snap and snap["state"] == "streaming":
            return snap
        await asyncio.sleep(0.01)
    raise AssertionError(f"job {job_id} did not reach streaming in {timeout}s")


# ── handler dispatch ──────────────────────────────────────────────────

async def test_run_one_happy_path(repo_db):
    """Step 10 changed the 'done' path to mark_ready_with_lifecycle, which
    reads prev_selected_image_id from host_repo.get_state instead of
    accepting it from the handler. Without any studio_hosts state seeded
    in this fixture, prev_selected is None — that's the correct
    contract. The repo-level test in test_studio_jobs_repo covers the
    full lifecycle with actual host_repo data."""
    runner = JobRunner(sweep_interval_s=3600)

    async def handler(job_id, blob):
        yield {"type": "candidate", "variant": {"image_id": "v1"}}
        yield {"type": "candidate", "variant": {"image_id": "v2"}}
        yield {"type": "done", "batch_id": "batch-x"}

    runner.register_handler("host", handler)
    await runner.start()
    try:
        job = await repo.create(user_id="u1", kind="host",
                                input_hash="h1", input_blob={"face": "/x"})
        await runner.submit(job["id"])
        snap = await _wait_terminal(job["id"])
        assert snap["state"] == "ready"
        assert snap["batch_id"] == "batch-x"
        # No studio_hosts seed → no prev_selected.
        assert snap["prev_selected_image_id"] is None
        assert [v["image_id"] for v in snap["variants"]] == ["v1", "v2"]
    finally:
        await runner.stop()


async def test_handler_emits_fatal(repo_db):
    runner = JobRunner(sweep_interval_s=3600)

    async def handler(job_id, blob):
        yield {"type": "candidate", "variant": {"image_id": "v1"}}
        yield {"type": "fatal", "error": "GPU OOM"}

    runner.register_handler("host", handler)
    await runner.start()
    try:
        job = await repo.create(user_id="u1", kind="host",
                                input_hash="h1", input_blob={})
        await runner.submit(job["id"])
        snap = await _wait_terminal(job["id"])
        assert snap["state"] == "failed"
        assert snap["error"] == "GPU OOM"
        assert len(snap["variants"]) == 1
    finally:
        await runner.stop()


async def test_handler_raises_marks_failed(repo_db):
    runner = JobRunner(sweep_interval_s=3600)

    async def handler(job_id, blob):
        yield {"type": "candidate", "variant": {"image_id": "v1"}}
        raise RuntimeError("boom")

    runner.register_handler("host", handler)
    await runner.start()
    try:
        job = await repo.create(user_id="u1", kind="host",
                                input_hash="h1", input_blob={})
        await runner.submit(job["id"])
        snap = await _wait_terminal(job["id"])
        assert snap["state"] == "failed"
        assert "boom" in (snap["error"] or "")
    finally:
        await runner.stop()


async def test_handler_exhausts_without_terminal(repo_db):
    runner = JobRunner(sweep_interval_s=3600)

    async def handler(job_id, blob):
        yield {"type": "candidate", "variant": {"image_id": "v1"}}
        # forgets to yield done/fatal — protocol violation.

    runner.register_handler("host", handler)
    await runner.start()
    try:
        job = await repo.create(user_id="u1", kind="host",
                                input_hash="h1", input_blob={})
        await runner.submit(job["id"])
        snap = await _wait_terminal(job["id"])
        assert snap["state"] == "failed"
        assert "without done/fatal" in (snap["error"] or "")
    finally:
        await runner.stop()


async def test_no_handler_registered_marks_failed(repo_db):
    runner = JobRunner(sweep_interval_s=3600)
    await runner.start()
    try:
        # composite has no handler.
        job = await repo.create(user_id="u1", kind="composite",
                                input_hash="h1", input_blob={})
        await runner.submit(job["id"])
        snap = await _wait_terminal(job["id"])
        assert snap["state"] == "failed"
        assert "no handler" in (snap["error"] or "")
    finally:
        await runner.stop()


async def test_unknown_event_type_is_ignored(repo_db):
    """Unknown event types log a warning but don't abort the run."""
    runner = JobRunner(sweep_interval_s=3600)

    async def handler(job_id, blob):
        yield {"type": "candidate", "variant": {"image_id": "v1"}}
        yield {"type": "garbage", "payload": "?"}
        yield {"type": "done", "batch_id": "b"}

    runner.register_handler("host", handler)
    await runner.start()
    try:
        job = await repo.create(user_id="u1", kind="host",
                                input_hash="h1", input_blob={})
        await runner.submit(job["id"])
        snap = await _wait_terminal(job["id"])
        assert snap["state"] == "ready"
    finally:
        await runner.stop()


# ── cancel-vs-append ──────────────────────────────────────────────────

async def test_user_cancel_breaks_loop_via_append_returning_false(repo_db):
    runner = JobRunner(sweep_interval_s=3600)
    proceed = asyncio.Event()
    seen_after_cancel = asyncio.Event()
    saw_extra_append = False

    async def handler(job_id, blob):
        nonlocal saw_extra_append
        yield {"type": "candidate", "variant": {"image_id": "v1"}}
        await proceed.wait()  # test triggers cancel here
        # The runner should NOT iterate past the next yield after cancel —
        # this lets us assert the loop broke.
        yield {"type": "candidate", "variant": {"image_id": "v2"}}
        saw_extra_append = True
        seen_after_cancel.set()
        yield {"type": "done", "batch_id": "b"}

    runner.register_handler("host", handler)
    await runner.start()
    try:
        job = await repo.create(user_id="u1", kind="host",
                                input_hash="h1", input_blob={})
        await runner.submit(job["id"])
        await _wait_streaming(job["id"])
        # User cancels via DELETE.
        ok = await repo.mark_cancelled(job["id"], owner_user_id="u1")
        assert ok is True
        proceed.set()  # let the handler yield v2
        snap = await _wait_terminal(job["id"])
        assert snap["state"] == "cancelled"
        # The loop must have broken on append_variant returning False —
        # the second yield happens but the runner exits before the third.
        # variants stays at 1.
        assert len(snap["variants"]) == 1
    finally:
        await runner.stop()


async def test_handler_finally_runs_on_cancel(repo_db):
    """eng-spec §4: handler can register cleanup in finally to unlink the
    just-saved file when the runner breaks the loop."""
    runner = JobRunner(sweep_interval_s=3600)
    finally_ran = asyncio.Event()
    proceed = asyncio.Event()

    async def handler(job_id, blob):
        try:
            yield {"type": "candidate", "variant": {"image_id": "v1"}}
            await proceed.wait()
            yield {"type": "candidate", "variant": {"image_id": "v2"}}
            yield {"type": "done", "batch_id": "b"}
        finally:
            finally_ran.set()

    runner.register_handler("host", handler)
    await runner.start()
    try:
        job = await repo.create(user_id="u1", kind="host",
                                input_hash="h1", input_blob={})
        await runner.submit(job["id"])
        await _wait_streaming(job["id"])
        await repo.mark_cancelled(job["id"], owner_user_id="u1")
        proceed.set()
        await _wait_terminal(job["id"])
        # Give aclose() a tick to run.
        await asyncio.wait_for(finally_ran.wait(), timeout=2.0)
    finally:
        await runner.stop()


# ── recovery ──────────────────────────────────────────────────────────

async def test_start_recovers_orphan_active_rows(repo_db):
    """A row in pending/streaming at start time is unreachable. Mark failed."""
    pending = await repo.create(user_id="u1", kind="host",
                                input_hash="a", input_blob={})
    streaming = await repo.create(user_id="u1", kind="host",
                                  input_hash="b", input_blob={})
    await repo.mark_streaming(streaming["id"])

    runner = JobRunner(sweep_interval_s=3600)
    await runner.start()
    try:
        snap_p = await repo.get_by_id_internal(pending["id"])
        snap_s = await repo.get_by_id_internal(streaming["id"])
        assert snap_p["state"] == "failed"
        assert snap_s["state"] == "failed"
        assert "restarted" in (snap_p["error"] or "")
    finally:
        await runner.stop()


# ── heartbeat sweep ───────────────────────────────────────────────────

async def test_heartbeat_sweep_fails_stalled_streaming(repo_db):
    """A streaming row with stale heartbeat gets reaped by the sweep.

    Seed AFTER runner.start() so the startup _recover_interrupted pass (which
    fails ALL active rows) doesn't clobber our test row before the sweep
    has a chance to see it."""
    db = repo_db
    runner = JobRunner(
        sweep_interval_s=0.05,
        heartbeat_timeout=timedelta(minutes=5),
    )
    await runner.start()
    try:
        # Seed a streaming row with a backdated heartbeat — simulates a
        # silently stalled worker.
        job = await repo.create(user_id="u1", kind="host",
                                input_hash="h1", input_blob={})
        await repo.mark_streaming(job["id"])
        long_ago = datetime.now(timezone.utc) - timedelta(minutes=30)
        await db.generation_jobs.update_one(
            {"_id": job["id"]}, {"$set": {"heartbeat_at": long_ago}},
        )

        # Wait for the next sweep tick.
        for _ in range(60):
            await asyncio.sleep(0.05)
            snap = await repo.get_by_id_internal(job["id"])
            if snap and snap["state"] == "failed":
                break
        snap = await repo.get_by_id_internal(job["id"])
        assert snap["state"] == "failed"
        assert "heartbeat" in (snap["error"] or "")
    finally:
        await runner.stop()


# ── graceful shutdown ─────────────────────────────────────────────────

async def test_stop_cancels_in_flight_and_marks_failed(repo_db):
    runner = JobRunner(sweep_interval_s=3600)
    started = asyncio.Event()

    async def slow(job_id, blob):
        yield {"type": "candidate", "variant": {"image_id": "v1"}}
        started.set()
        await asyncio.sleep(60)  # blocks until cancelled
        yield {"type": "done", "batch_id": "b"}

    runner.register_handler("host", slow)
    await runner.start()
    job = await repo.create(user_id="u1", kind="host",
                            input_hash="h1", input_blob={})
    await runner.submit(job["id"])
    await asyncio.wait_for(started.wait(), timeout=2.0)

    await runner.stop()
    snap = await repo.get_by_id_internal(job["id"])
    assert snap["state"] == "failed"
    # mark_failed wrote either "cancelled by server" (from CancelledError
    # branch) or "server shutdown" (from stop()'s defensive call). Either is
    # acceptable; just assert it's not still streaming.
    assert snap["error"] in ("cancelled by server", "server shutdown")


async def test_submit_after_stop_raises(repo_db):
    runner = JobRunner(sweep_interval_s=3600)
    await runner.start()
    await runner.stop()
    with pytest.raises(RuntimeError, match="stopping"):
        await runner.submit("any-job-id")


async def test_submit_idempotent(repo_db):
    runner = JobRunner(sweep_interval_s=3600)
    proceed = asyncio.Event()
    runs = 0

    async def handler(job_id, blob):
        nonlocal runs
        runs += 1
        await proceed.wait()
        yield {"type": "done", "batch_id": "b"}

    runner.register_handler("host", handler)
    await runner.start()
    try:
        job = await repo.create(user_id="u1", kind="host",
                                input_hash="h1", input_blob={})
        await runner.submit(job["id"])
        await runner.submit(job["id"])  # second submit is a no-op
        await runner.submit(job["id"])
        await _wait_streaming(job["id"])
        assert runs == 1
        proceed.set()
        await _wait_terminal(job["id"])
    finally:
        await runner.stop()


# ── handler registration ──────────────────────────────────────────────

async def test_register_handler_rejects_unknown_kind(repo_db):
    runner = JobRunner(sweep_interval_s=3600)

    async def h(job_id, blob):
        yield {"type": "done", "batch_id": "b"}

    with pytest.raises(ValueError, match="kind must be"):
        runner.register_handler("ghost", h)


# ── publisher integration ─────────────────────────────────────────────

async def test_publisher_sees_events(repo_db):
    seen: list[tuple[str, dict]] = []

    async def publisher(job_id: str, evt: dict) -> None:
        seen.append((job_id, evt))

    runner = JobRunner(publisher=publisher, sweep_interval_s=3600)

    async def handler(job_id, blob):
        yield {"type": "candidate", "variant": {"image_id": "v1"}}
        yield {"type": "done", "batch_id": "b"}

    runner.register_handler("host", handler)
    await runner.start()
    try:
        job = await repo.create(user_id="u1", kind="host",
                                input_hash="h1", input_blob={})
        await runner.submit(job["id"])
        await _wait_terminal(job["id"])
        kinds = [evt["type"] for _jid, evt in seen]
        assert "candidate" in kinds
        assert "done" in kinds
    finally:
        await runner.stop()


# ── single-process fail-fast (step 11) ────────────────────────────────

def test_assert_single_process_passes_when_unset(monkeypatch):
    """Default (WEB_CONCURRENCY unset) is single-process — boot proceeds."""
    monkeypatch.delenv("WEB_CONCURRENCY", raising=False)
    assert_single_process_or_raise()  # no raise


def test_assert_single_process_passes_when_one(monkeypatch):
    monkeypatch.setenv("WEB_CONCURRENCY", "1")
    assert_single_process_or_raise()


def test_assert_single_process_raises_on_two(monkeypatch):
    monkeypatch.setenv("WEB_CONCURRENCY", "2")
    with pytest.raises(RuntimeError, match="single-process"):
        assert_single_process_or_raise()


def test_assert_single_process_raises_on_large_value(monkeypatch):
    """Any value > 1 trips the guard — proxies catch a typical
    `gunicorn -w 4` config that passes through env."""
    monkeypatch.setenv("WEB_CONCURRENCY", "8")
    with pytest.raises(RuntimeError, match="single-process"):
        assert_single_process_or_raise()


def test_assert_single_process_raises_on_garbage(monkeypatch):
    """Malformed values surface a config error rather than fall through
    to a permissive default."""
    monkeypatch.setenv("WEB_CONCURRENCY", "asdf")
    with pytest.raises(RuntimeError, match="must be an integer"):
        assert_single_process_or_raise()


async def test_publisher_error_does_not_break_loop(repo_db):
    """A flaky pubsub must not poison the run loop. The DB row stays
    authoritative; SSE clients can resync via the snapshot endpoint."""

    async def publisher(job_id: str, evt: dict) -> None:
        raise RuntimeError("pubsub down")

    runner = JobRunner(publisher=publisher, sweep_interval_s=3600)

    async def handler(job_id, blob):
        yield {"type": "candidate", "variant": {"image_id": "v1"}}
        yield {"type": "done", "batch_id": "b"}

    runner.register_handler("host", handler)
    await runner.start()
    try:
        job = await repo.create(user_id="u1", kind="host",
                                input_hash="h1", input_blob={})
        await runner.submit(job["id"])
        snap = await _wait_terminal(job["id"])
        assert snap["state"] == "ready"
    finally:
        await runner.stop()
