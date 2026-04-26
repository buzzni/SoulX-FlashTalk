"""Real /api/auth/login round-trips (no autouse auth bypass).

Per conftest.py, this file's module name opts it out of the auth bypass.
TestClient hits the real middleware + login endpoint.
"""
from __future__ import annotations

import os

import bcrypt
import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from motor.motor_asyncio import AsyncIOMotorClient


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}_authlogin"


def _hash(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt(rounds=12)).decode()


@pytest_asyncio.fixture
async def app_with_test_db(monkeypatch):
    monkeypatch.setattr("config.MONGO_URL", "mongodb://localhost:27017")
    monkeypatch.setattr("config.DB_NAME", _test_db_name())
    monkeypatch.setattr("config.STUDIO_JWT_SECRET", "test-secret-32-bytes-min-fake-not-real-secret")

    pre = AsyncIOMotorClient("mongodb://localhost:27017", serverSelectionTimeoutMS=2000)
    db = pre[_test_db_name()]
    for coll in await db.list_collection_names():
        await db[coll].drop()
    await db.users.insert_many([
        {"user_id": "alice", "is_active": True, "approval_status": "approved",
         "role": "member", "subscriptions": ["platform", "studio"],
         "studio_token_version": 0, "hashed_password": _hash("alice-pw")},
        {"user_id": "bob", "is_active": True, "approval_status": "approved",
         "role": "member", "subscriptions": ["platform"],   # no studio
         "studio_token_version": 0, "hashed_password": _hash("bob-pw")},
        {"user_id": "carol", "is_active": False, "approval_status": "approved",
         "role": "member", "subscriptions": ["platform", "studio"],
         "studio_token_version": 0, "hashed_password": _hash("carol-pw")},
        {"user_id": "dave", "is_active": True, "approval_status": "pending",
         "role": "member", "subscriptions": ["platform", "studio"],
         "studio_token_version": 0, "hashed_password": _hash("dave-pw")},
    ])
    pre.close()

    import app as app_module
    with TestClient(app_module.app) as c:
        yield c

    pre = AsyncIOMotorClient("mongodb://localhost:27017", serverSelectionTimeoutMS=2000)
    for coll in await pre[_test_db_name()].list_collection_names():
        await pre[_test_db_name()][coll].drop()
    pre.close()


def _login(client, user_id, password):
    return client.post("/api/auth/login", json={"user_id": user_id, "password": password})


def test_login_happy_path_returns_token(app_with_test_db):
    r = _login(app_with_test_db, "alice", "alice-pw")
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"]
    assert body["expires_in"] == 7 * 24 * 3600
    assert body["user"]["user_id"] == "alice"
    assert body["user"]["subscriptions"] == ["platform", "studio"]
    # hashed_password must NOT be in the response
    assert "hashed_password" not in body["user"]


def test_login_wrong_password_returns_401(app_with_test_db):
    r = _login(app_with_test_db, "alice", "not-the-password")
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid credentials"}


def test_login_unknown_user_returns_401(app_with_test_db):
    r = _login(app_with_test_db, "ghost", "anything")
    assert r.status_code == 401
    # Don't leak which check failed
    assert r.json() == {"detail": "invalid credentials"}


def test_login_no_studio_subscription_returns_401(app_with_test_db):
    r = _login(app_with_test_db, "bob", "bob-pw")
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid credentials"}


def test_login_inactive_user_returns_401(app_with_test_db):
    r = _login(app_with_test_db, "carol", "carol-pw")
    assert r.status_code == 401


def test_login_unapproved_user_returns_401(app_with_test_db):
    r = _login(app_with_test_db, "dave", "dave-pw")
    assert r.status_code == 401


def test_login_empty_credentials_returns_401(app_with_test_db):
    assert _login(app_with_test_db, "", "").status_code == 401
    assert _login(app_with_test_db, "alice", "").status_code == 401
    assert _login(app_with_test_db, "", "alice-pw").status_code == 401


def test_login_then_me_works(app_with_test_db):
    r = _login(app_with_test_db, "alice", "alice-pw")
    token = r.json()["access_token"]
    me = app_with_test_db.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["user_id"] == "alice"


def test_login_then_logout_invalidates_old_token(app_with_test_db):
    r = _login(app_with_test_db, "alice", "alice-pw")
    token = r.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # token works
    assert app_with_test_db.get("/api/auth/me", headers=headers).status_code == 200

    # logout
    lo = app_with_test_db.post("/api/auth/logout", headers=headers)
    assert lo.status_code == 200
    assert lo.json()["ok"] is True
    assert lo.json()["studio_token_version"] == 1

    # old token is now revoked
    after = app_with_test_db.get("/api/auth/me", headers=headers)
    assert after.status_code == 401
    assert after.json()["detail"] == "token revoked"
