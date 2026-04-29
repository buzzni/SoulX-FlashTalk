"""Tests for studio_saved_host_repo: CRUD + user scoping."""
from __future__ import annotations

import os
from pathlib import Path

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

import config
from modules import db as db_module
from modules.repositories import studio_saved_host_repo as repo


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}_savedhost"


@pytest_asyncio.fixture
async def repo_db(monkeypatch, tmp_path):
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    examples = tmp_path / "examples"
    for d in (uploads, outputs, examples, outputs / "hosts" / "saved"):
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


def _write_png(path: Path, content: bytes = b"png-bytes"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


async def test_create_returns_public_shape(repo_db):
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "abc123.png"; _write_png(p)
    out = await repo.create("u1", host_id="abc123", name="my host",
                             storage_key="outputs/hosts/saved/abc123.png")
    assert out["id"] == "abc123"
    assert out["name"] == "my host"
    assert out["url"] == "/api/files/outputs/hosts/saved/abc123.png"
    assert out["created_at"] is not None


async def test_create_persists_meta(repo_db):
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "abc123.png"; _write_png(p)
    out = await repo.create("u1", host_id="abc123", name="x",
                             storage_key="outputs/hosts/saved/abc123.png",
                             meta={"seed": 42, "prompt": "p"})
    assert out["meta"] == {"seed": 42, "prompt": "p"}


async def test_create_idempotent_by_host_id(repo_db):
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "abc123.png"; _write_png(p)
    o1 = await repo.create("u1", host_id="abc123", name="first",
                             storage_key="outputs/hosts/saved/abc123.png")
    o2 = await repo.create("u1", host_id="abc123", name="second",
                             storage_key="outputs/hosts/saved/abc123.png")
    items = await repo.list_for_user("u1")
    assert len(items) == 1
    assert items[0]["name"] == "second"
    # created_at preserved on second call
    assert items[0]["created_at"] == o1["created_at"]


async def test_list_for_user_returns_newest_first(repo_db):
    _, outputs = repo_db
    for i in range(3):
        p = outputs / "hosts" / "saved" / f"id{i}.png"; _write_png(p)
        await repo.create("u1", host_id=f"id{i}", name=f"h{i}",
                           storage_key=f"outputs/hosts/saved/id{i}.png")
    items = await repo.list_for_user("u1")
    assert len(items) == 3
    assert items[0]["id"] == "id2"
    assert items[2]["id"] == "id0"


async def test_list_for_user_isolation(repo_db):
    _, outputs = repo_db
    pa = outputs / "hosts" / "saved" / "alice.png"; _write_png(pa)
    pb = outputs / "hosts" / "saved" / "bob.png"; _write_png(pb)
    await repo.create("alice", host_id="alice", name="a",
                       storage_key="outputs/hosts/saved/alice.png")
    await repo.create("bob", host_id="bob", name="b",
                       storage_key="outputs/hosts/saved/bob.png")
    assert len(await repo.list_for_user("alice")) == 1
    assert (await repo.list_for_user("alice"))[0]["id"] == "alice"
    assert len(await repo.list_for_user("bob")) == 1


async def test_get_returns_doc(repo_db):
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "abc.png"; _write_png(p)
    await repo.create("u1", host_id="abc", name="x",
                       storage_key="outputs/hosts/saved/abc.png")
    out = await repo.get("u1", "abc")
    assert out["id"] == "abc"


async def test_get_returns_none_for_missing(repo_db):
    assert await repo.get("u1", "ghost") is None


async def test_delete_soft_deletes_row_keeps_file(repo_db):
    """Saved-host eng-review decision #10: delete is soft.

    Row is hidden from list_for_user/get, but the backing file stays on
    disk so any wizard draft that already injected this host can still
    generate during the retention window. A separate cron eventually
    GCs the file.
    """
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "abc.png"; _write_png(p)
    await repo.create("u1", host_id="abc", name="x",
                       storage_key="outputs/hosts/saved/abc.png")
    assert p.exists()
    ok = await repo.delete("u1", "abc")
    assert ok is True
    assert p.exists()  # soft-delete: file untouched
    assert await repo.get("u1", "abc") is None  # hidden from live reads
    # but the row is still in mongo with deleted_at set
    raw = await repo._coll().find_one({"user_id": "u1", "host_id": "abc"})
    assert raw is not None
    assert raw.get("deleted_at") is not None


async def test_delete_owner_mismatch_returns_false(repo_db):
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "abc.png"; _write_png(p)
    await repo.create("alice", host_id="abc", name="x",
                       storage_key="outputs/hosts/saved/abc.png")
    ok = await repo.delete("bob", "abc")  # bob doesn't own it
    assert ok is False
    assert p.exists()
    assert await repo.get("alice", "abc") is not None


async def test_delete_missing_returns_false(repo_db):
    assert await repo.delete("u1", "ghost") is False


async def test_delete_already_deleted_returns_false(repo_db):
    """Calling delete on an already-soft-deleted row is a no-op (False)."""
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "abc.png"; _write_png(p)
    await repo.create("u1", host_id="abc", name="x",
                       storage_key="outputs/hosts/saved/abc.png")
    assert await repo.delete("u1", "abc") is True
    assert await repo.delete("u1", "abc") is False  # second call, no-op


async def test_list_excludes_soft_deleted(repo_db):
    _, outputs = repo_db
    for i in range(3):
        p = outputs / "hosts" / "saved" / f"id{i}.png"; _write_png(p)
        await repo.create("u1", host_id=f"id{i}", name=f"h{i}",
                           storage_key=f"outputs/hosts/saved/id{i}.png")
    await repo.delete("u1", "id1")
    items = await repo.list_for_user("u1")
    ids = [it["id"] for it in items]
    assert "id1" not in ids
    assert sorted(ids) == ["id0", "id2"]


async def test_update_name_renames_live_row(repo_db):
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "abc.png"; _write_png(p)
    await repo.create("u1", host_id="abc", name="old",
                       storage_key="outputs/hosts/saved/abc.png")
    out = await repo.update_name("u1", "abc", "new name")
    assert out is not None
    assert out["name"] == "new name"
    assert out["updated_at"] is not None


async def test_update_name_missing_row_returns_none(repo_db):
    assert await repo.update_name("u1", "ghost", "x") is None


async def test_update_name_owner_mismatch_returns_none(repo_db):
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "abc.png"; _write_png(p)
    await repo.create("alice", host_id="abc", name="x",
                       storage_key="outputs/hosts/saved/abc.png")
    assert await repo.update_name("bob", "abc", "hijack") is None
    # alice's row untouched
    a = await repo.get("alice", "abc")
    assert a["name"] == "x"


async def test_update_name_rejects_soft_deleted(repo_db):
    """Renaming a soft-deleted row returns None — treats deleted as gone."""
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "abc.png"; _write_png(p)
    await repo.create("u1", host_id="abc", name="old",
                       storage_key="outputs/hosts/saved/abc.png")
    await repo.delete("u1", "abc")
    assert await repo.update_name("u1", "abc", "new") is None


async def test_create_does_not_resurrect_soft_deleted(repo_db):
    """If a row was soft-deleted, calling create with the same host_id
    must NOT clear deleted_at — caller is responsible for issuing a
    fresh host_id (uuid4) on save flows so tombstones can't reappear
    in the user's library by accident.
    """
    _, outputs = repo_db
    p = outputs / "hosts" / "saved" / "abc.png"; _write_png(p)
    await repo.create("u1", host_id="abc", name="orig",
                       storage_key="outputs/hosts/saved/abc.png")
    await repo.delete("u1", "abc")
    # Re-save with same host_id (caller's mistake — should normally use new uuid)
    await repo.create("u1", host_id="abc", name="resurrected",
                       storage_key="outputs/hosts/saved/abc.png")
    assert await repo.get("u1", "abc") is None  # still hidden
    raw = await repo._coll().find_one({"user_id": "u1", "host_id": "abc"})
    assert raw["deleted_at"] is not None  # tombstone preserved
