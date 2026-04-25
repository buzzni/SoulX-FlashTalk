"""Tests for studio_host_repo: state machine, partial unique enforcement,
file-row coupling on delete."""
from __future__ import annotations

import os
from pathlib import Path

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

import config
from modules import db as db_module
from modules.repositories import studio_host_repo as repo


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}_studiohost"


@pytest_asyncio.fixture
async def repo_db(monkeypatch, tmp_path):
    """Per-worker test DB + isolated bucket dirs so file ops don't touch repo."""
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    examples = tmp_path / "examples"
    for d in (uploads, outputs, examples, outputs / "hosts" / "saved",
              outputs / "composites"):
        d.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(examples))
    monkeypatch.setattr(config, "MONGO_URL", "mongodb://localhost:27017")
    monkeypatch.setattr(config, "DB_NAME", _test_db_name())

    pre = AsyncIOMotorClient("mongodb://localhost:27017", serverSelectionTimeoutMS=2000)
    pre_db = pre[_test_db_name()]
    for c in await pre_db.list_collection_names():
        await pre_db[c].drop()
    pre.close()

    await db_module.init()
    yield db_module.get_db(), outputs
    d = db_module.get_db()
    for c in await d.list_collection_names():
        await d[c].drop()
    await db_module.close()


def _write_png(path: Path, content: bytes = b"png-bytes") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


# ── upsert + record_batch ──────────────────────────────────────────────

async def test_record_batch_creates_drafts(repo_db):
    db, outputs = repo_db
    p1 = outputs / "hosts" / "saved" / "host_a_s1.png"
    p2 = outputs / "hosts" / "saved" / "host_b_s2.png"
    _write_png(p1); _write_png(p2)
    await repo.record_batch("u1", "1-host", [str(p1), str(p2)], "batch-x")

    docs = [d async for d in db.studio_hosts.find({"user_id": "u1"})]
    assert len(docs) == 2
    by_id = {d["image_id"]: d for d in docs}
    assert by_id["host_a_s1"]["status"] == "draft"
    assert by_id["host_a_s1"]["batch_id"] == "batch-x"
    assert by_id["host_a_s1"]["storage_key"] == "outputs/hosts/saved/host_a_s1.png"
    assert by_id["host_a_s1"]["is_prev_selected"] is False


async def test_record_batch_is_idempotent(repo_db):
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "host_x_s1.png"; _write_png(p)
    await repo.record_batch("u1", "1-host", [str(p)], "b1")
    await repo.record_batch("u1", "1-host", [str(p)], "b1")  # second time
    state = await repo.get_state("u1", "1-host")
    assert len(state["drafts"]) == 1


# ── select / partial unique ────────────────────────────────────────────

async def test_select_promotes_target_demotes_others(repo_db):
    _, outputs = repo_db
    paths = [outputs / "hosts" / "saved" / f"host_{i}_s1.png" for i in range(3)]
    for p in paths: _write_png(p)
    await repo.record_batch("u1", "1-host", [str(p) for p in paths], "b1")

    rec = await repo.select("u1", "1-host", "host_1_s1")
    assert rec["image_id"] == "host_1_s1"
    state = await repo.get_state("u1", "1-host")
    assert state["selected"]["image_id"] == "host_1_s1"
    assert len(state["drafts"]) == 2


async def test_select_switches_target(repo_db):
    """Selecting B after A leaves only B selected (decision #11)."""
    _, outputs = repo_db
    a = outputs / "hosts" / "saved" / "host_a_s1.png"; _write_png(a)
    b = outputs / "hosts" / "saved" / "host_b_s1.png"; _write_png(b)
    await repo.record_batch("u1", "1-host", [str(a), str(b)], "b1")
    await repo.select("u1", "1-host", "host_a_s1")
    await repo.select("u1", "1-host", "host_b_s1")
    state = await repo.get_state("u1", "1-host")
    assert state["selected"]["image_id"] == "host_b_s1"
    # exactly one selected per (user, step)
    db, _ = repo_db
    n_selected = await db.studio_hosts.count_documents(
        {"user_id": "u1", "step": "1-host", "status": "selected"})
    assert n_selected == 1


async def test_select_unknown_raises(repo_db):
    with pytest.raises(LookupError):
        await repo.select("u1", "1-host", "ghost")


async def test_select_committed_raises(repo_db):
    """Cannot re-select a committed image."""
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "host_a_s1.png"; _write_png(p)
    await repo.record_batch("u1", "1-host", [str(p)], "b1")
    await repo.select("u1", "1-host", "host_a_s1")
    await repo.commit("u1", "1-host", "video-1")
    with pytest.raises(ValueError):
        await repo.select("u1", "1-host", "host_a_s1")


# ── commit ─────────────────────────────────────────────────────────────

async def test_commit_promotes_selected_and_deletes_drafts(repo_db):
    db, outputs = repo_db
    paths = [outputs / "hosts" / "saved" / f"host_{i}_s1.png" for i in range(3)]
    for p in paths: _write_png(p)
    await repo.record_batch("u1", "1-host", [str(p) for p in paths], "b1")
    await repo.select("u1", "1-host", "host_1_s1")
    image_id = await repo.commit("u1", "1-host", "video-1")
    assert image_id == "host_1_s1"
    docs = [d async for d in db.studio_hosts.find({"user_id": "u1"})]
    assert len(docs) == 1
    assert docs[0]["status"] == "committed"
    assert docs[0]["video_ids"] == ["video-1"]
    # Other PNGs deleted
    assert (outputs / "hosts" / "saved" / "host_1_s1.png").exists()
    assert not (outputs / "hosts" / "saved" / "host_0_s1.png").exists()


async def test_commit_no_selected_returns_none(repo_db):
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "host_a_s1.png"; _write_png(p)
    await repo.record_batch("u1", "1-host", [str(p)], "b1")
    res = await repo.commit("u1", "1-host", "video-x")
    assert res is None


async def test_commit_dedupes_video_id_on_repeat(repo_db):
    db, outputs = repo_db
    p = outputs / "hosts" / "saved" / "host_a_s1.png"; _write_png(p)
    await repo.record_batch("u1", "1-host", [str(p)], "b1")
    await repo.select("u1", "1-host", "host_a_s1")
    await repo.commit("u1", "1-host", "video-1")
    # second commit with same video_id — no-op on video_ids
    # First we need to reselect, but committed can't re-select. Bypass with
    # direct update for the test.
    await db.studio_hosts.update_one({"image_id": "host_a_s1"},
                                       {"$set": {"status": "selected"}})
    await repo.commit("u1", "1-host", "video-1")
    doc = await db.studio_hosts.find_one({"image_id": "host_a_s1"})
    assert doc["video_ids"] == ["video-1"]


# ── cleanup_after_generate ─────────────────────────────────────────────

async def test_cleanup_demotes_selected_to_prev(repo_db):
    db, outputs = repo_db
    a = outputs / "hosts" / "saved" / "host_a_s1.png"; _write_png(a)
    await repo.record_batch("u1", "1-host", [str(a)], "b1")
    await repo.select("u1", "1-host", "host_a_s1")
    # Now a fresh batch arrives
    b = outputs / "hosts" / "saved" / "host_b_s1.png"; _write_png(b)
    await repo.record_batch("u1", "1-host", [str(b)], "b2")
    await repo.cleanup_after_generate("u1", "1-host", "b2")
    state = await repo.get_state("u1", "1-host")
    assert state["selected"] is None
    assert state["prev_selected"] is not None
    assert state["prev_selected"]["image_id"] == "host_a_s1"


async def test_cleanup_deletes_stale_drafts(repo_db):
    _, outputs = repo_db
    stale = outputs / "hosts" / "saved" / "host_old_s1.png"; _write_png(stale)
    await repo.record_batch("u1", "1-host", [str(stale)], "b1")
    fresh = outputs / "hosts" / "saved" / "host_new_s1.png"; _write_png(fresh)
    await repo.record_batch("u1", "1-host", [str(fresh)], "b2")
    await repo.cleanup_after_generate("u1", "1-host", "b2")
    state = await repo.get_state("u1", "1-host")
    draft_ids = sorted(d["image_id"] for d in state["drafts"])
    assert draft_ids == ["host_new_s1"]
    assert not stale.exists()  # file was also deleted


# ── delete_candidate ───────────────────────────────────────────────────

async def test_delete_candidate_removes_draft(repo_db):
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "host_x_s1.png"; _write_png(p)
    await repo.record_batch("u1", "1-host", [str(p)], "b1")
    out = await repo.delete_candidate("u1", "1-host", "host_x_s1")
    assert out == "deleted"
    assert not p.exists()


async def test_delete_candidate_refuses_committed(repo_db):
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "host_x_s1.png"; _write_png(p)
    await repo.record_batch("u1", "1-host", [str(p)], "b1")
    await repo.select("u1", "1-host", "host_x_s1")
    await repo.commit("u1", "1-host", "video-1")
    out = await repo.delete_candidate("u1", "1-host", "host_x_s1")
    assert out == "committed"
    assert p.exists()


async def test_delete_candidate_not_found(repo_db):
    out = await repo.delete_candidate("u1", "1-host", "ghost")
    assert out == "not_found"


# ── cascade_delete_by_video ────────────────────────────────────────────

async def test_cascade_delete_drops_video_ref(repo_db):
    db, outputs = repo_db
    p = outputs / "hosts" / "saved" / "host_a_s1.png"; _write_png(p)
    await repo.record_batch("u1", "1-host", [str(p)], "b1")
    await repo.select("u1", "1-host", "host_a_s1")
    await repo.commit("u1", "1-host", "video-1")
    # Manually attach a second video so cascade only drops video-1
    await db.studio_hosts.update_one(
        {"image_id": "host_a_s1"},
        {"$set": {"video_ids": ["video-1", "video-2"]}})
    removed = await repo.cascade_delete_by_video("u1", "video-1")
    assert removed == []  # row not deleted (video-2 still attached)
    doc = await db.studio_hosts.find_one({"image_id": "host_a_s1"})
    assert doc["video_ids"] == ["video-2"]


async def test_cascade_delete_removes_orphan(repo_db):
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "host_a_s1.png"; _write_png(p)
    await repo.record_batch("u1", "1-host", [str(p)], "b1")
    await repo.select("u1", "1-host", "host_a_s1")
    await repo.commit("u1", "1-host", "video-1")
    removed = await repo.cascade_delete_by_video("u1", "video-1")
    assert removed == ["host_a_s1"]
    assert not p.exists()


# ── user_id scoping ────────────────────────────────────────────────────

async def test_user_id_scoping_isolates_users(repo_db):
    _, outputs = repo_db
    pa = outputs / "hosts" / "saved" / "host_a_s1.png"; _write_png(pa)
    pb = outputs / "hosts" / "saved" / "host_b_s1.png"; _write_png(pb)
    await repo.record_batch("alice", "1-host", [str(pa)], "b1")
    await repo.record_batch("bob",   "1-host", [str(pb)], "b1")

    alice_state = await repo.get_state("alice", "1-host")
    assert len(alice_state["drafts"]) == 1
    assert alice_state["drafts"][0]["image_id"] == "host_a_s1"

    bob_state = await repo.get_state("bob", "1-host")
    assert len(bob_state["drafts"]) == 1
    assert bob_state["drafts"][0]["image_id"] == "host_b_s1"
