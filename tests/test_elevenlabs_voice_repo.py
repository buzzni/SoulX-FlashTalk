"""Tests for elevenlabs_voice_repo: per-user voice mapping with voice_id-unique upsert."""
from __future__ import annotations

import os

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

import config
from modules import db as db_module
from modules.repositories import elevenlabs_voice_repo as repo


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}_voicerepo"


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


async def test_add_returns_public_shape(repo_db):
    out = await repo.add("alice", voice_id="v1", name="Alice voice",
                          description="d", preview_url="https://x", labels={"lang": "ko"})
    assert out["voice_id"] == "v1"
    assert out["name"] == "Alice voice"
    assert out["category"] == "cloned"
    assert out["preview_url"] == "https://x"
    assert out["labels"] == {"lang": "ko"}
    assert out["description"] == "d"


async def test_add_idempotent_by_voice_id(repo_db):
    o1 = await repo.add("alice", voice_id="v1", name="first")
    o2 = await repo.add("alice", voice_id="v1", name="second")
    items = await repo.list_for_user("alice")
    assert len(items) == 1
    assert items[0]["name"] == "second"


async def test_list_for_user_isolation(repo_db):
    await repo.add("alice", voice_id="va", name="a")
    await repo.add("bob", voice_id="vb", name="b")
    assert [v["voice_id"] for v in await repo.list_for_user("alice")] == ["va"]
    assert [v["voice_id"] for v in await repo.list_for_user("bob")] == ["vb"]


async def test_list_for_user_empty(repo_db):
    assert await repo.list_for_user("ghost") == []


async def test_is_owner_true_for_owner(repo_db):
    await repo.add("alice", voice_id="v1", name="x")
    assert await repo.is_owner("alice", "v1") is True


async def test_is_owner_false_for_foreign(repo_db):
    await repo.add("alice", voice_id="v1", name="x")
    assert await repo.is_owner("bob", "v1") is False


async def test_is_owner_false_for_unknown(repo_db):
    assert await repo.is_owner("alice", "ghost") is False


async def test_get_owner_returns_user_id(repo_db):
    await repo.add("alice", voice_id="v1", name="x")
    assert await repo.get_owner("v1") == "alice"


async def test_get_owner_none_for_unknown(repo_db):
    assert await repo.get_owner("ghost") is None


async def test_delete_owner_succeeds(repo_db):
    await repo.add("alice", voice_id="v1", name="x")
    assert await repo.delete("alice", "v1") is True
    assert await repo.list_for_user("alice") == []


async def test_delete_foreign_user_no_op(repo_db):
    await repo.add("alice", voice_id="v1", name="x")
    assert await repo.delete("bob", "v1") is False
    # alice still owns it
    assert await repo.is_owner("alice", "v1") is True


async def test_delete_missing_returns_false(repo_db):
    assert await repo.delete("alice", "ghost") is False


async def test_voice_id_unique_across_users(repo_db):
    """Same voice_id can't be assigned to two users — the unique index
    forces the second add to overwrite the first row's user_id."""
    await repo.add("alice", voice_id="v1", name="alice's")
    # Re-adding with a different user is an upsert by (voice_id) — the
    # row's user_id flips. This is intentional: the workflow doesn't
    # produce shared cloned voice_ids; if it ever does we'd notice.
    await repo.add("bob", voice_id="v1", name="bob's")
    assert await repo.is_owner("alice", "v1") is False
    assert await repo.is_owner("bob", "v1") is True


async def test_touch_last_used_updates_field(repo_db):
    await repo.add("alice", voice_id="v1", name="x")
    coll = repo._coll()
    before = await coll.find_one({"voice_id": "v1"})
    assert before["last_used_at"] is None
    await repo.touch_last_used("alice", "v1")
    after = await coll.find_one({"voice_id": "v1"})
    assert after["last_used_at"] is not None


async def test_touch_last_used_foreign_user_no_op(repo_db):
    await repo.add("alice", voice_id="v1", name="x")
    await repo.touch_last_used("bob", "v1")
    coll = repo._coll()
    doc = await coll.find_one({"voice_id": "v1"})
    assert doc["last_used_at"] is None
