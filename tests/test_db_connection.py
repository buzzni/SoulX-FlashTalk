"""Smoke tests for modules.db: init, init_indexes idempotency, close.

Requires a local mongod listening on 127.0.0.1:27017 (PR0). Tests use a
per-worker DB name via PYTEST_XDIST_WORKER so parallel pytest is race-free.
"""
from __future__ import annotations

import os

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

from modules import db as db_module


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}"


@pytest_asyncio.fixture
async def isolated_db(monkeypatch):
    """Bind modules.db to a per-worker test DB and tear down after."""
    monkeypatch.setattr("config.MONGO_URL", "mongodb://localhost:27017")
    monkeypatch.setattr("config.DB_NAME", _test_db_name())
    # Ensure clean slate even if a previous run crashed mid-test
    pre = AsyncIOMotorClient("mongodb://localhost:27017",
                              serverSelectionTimeoutMS=2000)
    pre_db = pre[_test_db_name()]
    for coll in await pre_db.list_collection_names():
        if coll.startswith("studio_") or coll == "users":
            await pre_db[coll].drop()
    pre.close()

    await db_module.init()
    try:
        yield db_module.get_db()
    finally:
        # Drop everything we created
        d = db_module.get_db()
        for coll in await d.list_collection_names():
            if coll.startswith("studio_") or coll == "users":
                await d[coll].drop()
        await db_module.close()


@pytest.mark.asyncio
async def test_init_creates_expected_indexes(isolated_db):
    db = isolated_db
    # Force at least one write so the collection materializes
    await db.studio_hosts.insert_one({"user_id": "x", "image_id": "y", "step": "1-host", "status": "draft"})
    idx = {i["name"]: i for i in await db.studio_hosts.list_indexes().to_list(length=None)}
    assert "user_image_uniq" in idx
    assert idx["user_image_uniq"]["unique"] is True
    assert "user_step_status_gen" in idx
    assert "user_batch" in idx
    # Partial unique on selected
    sel = idx.get("one_selected_per_step")
    assert sel is not None
    assert sel.get("unique") is True
    assert sel.get("partialFilterExpression") == {"status": "selected"}


@pytest.mark.asyncio
async def test_init_indexes_is_idempotent(isolated_db):
    # Calling again must not raise
    await db_module.init_indexes()
    await db_module.init_indexes()


@pytest.mark.asyncio
async def test_partial_unique_blocks_second_selected(isolated_db):
    """A second status='selected' for the same (user_id, step) must fail."""
    db = isolated_db
    await db.studio_hosts.insert_one(
        {"user_id": "u1", "image_id": "img1", "step": "1-host", "status": "selected"}
    )
    from pymongo.errors import DuplicateKeyError
    with pytest.raises(DuplicateKeyError):
        await db.studio_hosts.insert_one(
            {"user_id": "u1", "image_id": "img2", "step": "1-host", "status": "selected"}
        )
    # Different status is fine
    await db.studio_hosts.insert_one(
        {"user_id": "u1", "image_id": "img3", "step": "1-host", "status": "draft"}
    )
    # Different step is fine
    await db.studio_hosts.insert_one(
        {"user_id": "u1", "image_id": "img4", "step": "2-composite", "status": "selected"}
    )


@pytest.mark.asyncio
async def test_user_image_uniq_blocks_duplicates(isolated_db):
    db = isolated_db
    await db.studio_hosts.insert_one(
        {"user_id": "u1", "image_id": "img1", "step": "1-host", "status": "draft"}
    )
    from pymongo.errors import DuplicateKeyError
    with pytest.raises(DuplicateKeyError):
        await db.studio_hosts.insert_one(
            {"user_id": "u1", "image_id": "img1", "step": "1-host", "status": "draft"}
        )


@pytest.mark.asyncio
async def test_close_releases_client():
    """init then close should leave the module usable for re-init."""
    await db_module.init()
    await db_module.close()
    # Re-init must succeed
    await db_module.init()
    await db_module.close()
