"""Tests for modules.repositories.user_repo (find_by_id, has_subscription, bump)."""
from __future__ import annotations

import os
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

from modules import db as db_module
from modules.repositories import user_repo


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}"


@pytest_asyncio.fixture
async def seeded_db(monkeypatch):
    monkeypatch.setattr("config.MONGO_URL", "mongodb://localhost:27017")
    monkeypatch.setattr("config.DB_NAME", _test_db_name())

    pre = AsyncIOMotorClient("mongodb://localhost:27017", serverSelectionTimeoutMS=2000)
    pre_db = pre[_test_db_name()]
    for coll in await pre_db.list_collection_names():
        if coll.startswith("studio_") or coll == "users":
            await pre_db[coll].drop()
    pre.close()

    await db_module.init()
    db = db_module.get_db()
    now = datetime.now(timezone.utc)
    await db.users.insert_many([
        {
            "user_id": "alice", "display_name": "Alice", "role": "member",
            "is_active": True, "approval_status": "approved",
            "subscriptions": ["platform", "studio"],
            "studio_token_version": 0, "created_at": now,
        },
        {
            "user_id": "bob", "display_name": "Bob", "role": "member",
            "is_active": True, "approval_status": "approved",
            "subscriptions": ["platform"],   # no studio
            "studio_token_version": 5, "created_at": now,
        },
    ])
    try:
        yield db
    finally:
        for coll in await db.list_collection_names():
            if coll.startswith("studio_") or coll == "users":
                await db[coll].drop()
        await db_module.close()


@pytest.mark.asyncio
async def test_find_by_id_returns_user(seeded_db):
    u = await user_repo.find_by_id("alice")
    assert u is not None
    assert u["user_id"] == "alice"
    assert u["subscriptions"] == ["platform", "studio"]


@pytest.mark.asyncio
async def test_find_by_id_returns_none_for_missing(seeded_db):
    assert await user_repo.find_by_id("ghost") is None


@pytest.mark.asyncio
async def test_has_subscription_true(seeded_db):
    assert await user_repo.has_subscription("alice", "studio") is True
    assert await user_repo.has_subscription("alice", "platform") is True


@pytest.mark.asyncio
async def test_has_subscription_false(seeded_db):
    assert await user_repo.has_subscription("bob", "studio") is False


@pytest.mark.asyncio
async def test_has_subscription_unknown_user(seeded_db):
    assert await user_repo.has_subscription("ghost", "studio") is False


@pytest.mark.asyncio
async def test_bump_studio_token_version(seeded_db):
    new_v = await user_repo.bump_studio_token_version("bob")
    assert new_v == 6  # was 5
    # Verify in DB and that platform's token_version is untouched
    raw = await seeded_db.users.find_one({"user_id": "bob"})
    assert raw["studio_token_version"] == 6
    assert "token_version" not in raw or raw.get("token_version") != 6


@pytest.mark.asyncio
async def test_bump_studio_token_version_missing_user(seeded_db):
    with pytest.raises(LookupError):
        await user_repo.bump_studio_token_version("ghost")
