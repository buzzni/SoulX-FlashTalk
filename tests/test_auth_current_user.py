"""Real auth-middleware behavior tests (no autouse bypass)."""
from __future__ import annotations

import os

import bcrypt
import pytest_asyncio
from fastapi.testclient import TestClient
from motor.motor_asyncio import AsyncIOMotorClient


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}_authcurrent"


def _hash(p: str) -> str:
    return bcrypt.hashpw(p.encode(), bcrypt.gensalt(rounds=12)).decode()


@pytest_asyncio.fixture
async def client_and_token(monkeypatch):
    monkeypatch.setattr("config.MONGO_URL", "mongodb://localhost:27017")
    monkeypatch.setattr("config.DB_NAME", _test_db_name())
    monkeypatch.setattr("config.STUDIO_JWT_SECRET", "test-secret-32-bytes-min-fake-not-real-secret")

    pre = AsyncIOMotorClient("mongodb://localhost:27017", serverSelectionTimeoutMS=2000)
    db = pre[_test_db_name()]
    for coll in await db.list_collection_names():
        await db[coll].drop()
    await db.users.insert_one({
        "user_id": "eve", "is_active": True, "approval_status": "approved",
        "role": "member", "subscriptions": ["platform", "studio"],
        "studio_token_version": 0, "hashed_password": _hash("eve-pw"),
    })
    pre.close()

    import app as app_module
    with TestClient(app_module.app) as c:
        r = c.post("/api/auth/login", json={"user_id": "eve", "password": "eve-pw"})
        assert r.status_code == 200, r.text
        token = r.json()["access_token"]
        yield c, token

    pre = AsyncIOMotorClient("mongodb://localhost:27017", serverSelectionTimeoutMS=2000)
    for coll in await pre[_test_db_name()].list_collection_names():
        await pre[_test_db_name()][coll].drop()
    pre.close()


def test_public_path_no_auth_needed(client_and_token):
    c, _ = client_and_token
    assert c.get("/api/config").status_code == 200


def test_missing_authorization_returns_401(client_and_token):
    c, _ = client_and_token
    r = c.get("/api/auth/me")
    assert r.status_code == 401
    assert "Authorization" in r.json()["detail"]


def test_malformed_authorization_returns_401(client_and_token):
    c, _ = client_and_token
    for bad in ("Bearer", "Bearer ", "BadToken xxx", "Basic abc", "bearerxxx"):
        r = c.get("/api/auth/me", headers={"Authorization": bad})
        assert r.status_code == 401, f"expected 401 for {bad!r}"


def test_tampered_token_returns_401(client_and_token):
    c, token = client_and_token
    r = c.get("/api/auth/me", headers={"Authorization": f"Bearer {token}TAMPER"})
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid token"


def test_valid_token_passes(client_and_token):
    c, token = client_and_token
    r = c.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["user_id"] == "eve"


@pytest_asyncio.fixture
async def revoke_subscription():
    """Helper to remove 'studio' from eve's subscriptions during a test."""
    cli = AsyncIOMotorClient("mongodb://localhost:27017")
    db = cli[_test_db_name()]
    yield lambda: db.users.update_one({"user_id": "eve"},
                                       {"$set": {"subscriptions": ["platform"]}})
    cli.close()


async def test_subscription_revoked_returns_403(client_and_token, revoke_subscription):
    """Pull 'studio' from subscriptions mid-session → next request 403."""
    c, token = client_and_token
    headers = {"Authorization": f"Bearer {token}"}
    assert c.get("/api/auth/me", headers=headers).status_code == 200
    await revoke_subscription()
    after = c.get("/api/auth/me", headers=headers)
    assert after.status_code == 403
    assert after.json()["detail"] == "studio access revoked"
