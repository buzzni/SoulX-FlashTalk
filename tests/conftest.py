"""Shared pytest fixtures for HostStudio migration tests."""
from __future__ import annotations

import os

import pytest


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}_apitests"


_FAKE_USER = {
    "user_id": "testuser",
    "display_name": "Test User",
    "role": "member",
    "is_active": True,
    "approval_status": "approved",
    "subscriptions": ["platform", "studio"],
    "studio_token_version": 0,
    "hashed_password": "",
}


@pytest.fixture(autouse=True)
def _bypass_studio_auth(monkeypatch, request):
    """Tests run against a fake authenticated user by default (PR2).

    The PR2 auth middleware would otherwise 401 every TestClient request that
    doesn't send a real bearer token. Instead of plumbing tokens through every
    existing test, we swap the middleware function for a no-op that pins a
    fake user onto request.state.

    Tests that need to exercise the real auth round-trip (login flows,
    token revocation, subscription gating) opt out by adding the
    `@pytest.mark.real_auth` marker, or by living in a file named
    `test_auth_login.py` / `test_auth_current_user.py`.
    """
    if request.node.get_closest_marker("real_auth"):
        return
    mod_name = request.module.__name__.rsplit(".", 1)[-1]
    if mod_name in ("test_auth_login", "test_auth_current_user"):
        return
    # Repo tests do their own DB setup against per-worker test DBs.
    if mod_name in ("test_studio_host_repo", "test_studio_saved_host_repo",
                    "test_studio_result_repo", "test_studio_jobs_repo",
                    "test_job_runner",
                    "test_db_connection", "test_user_repo",
                    "test_studio_006_add_subscriptions", "test_storage_local",
                    "test_studio_007_local_import",
                    "test_studio_008_generation_jobs"):
        return

    # Redirect DB so api-level tests don't pollute the dev `ai_showhost`.
    # The TestClient's startup hook reads config.DB_NAME at fire time, so
    # patching here (before the client is constructed) takes effect.
    monkeypatch.setattr("config.MONGO_URL", "mongodb://localhost:27017")
    monkeypatch.setattr("config.DB_NAME", _test_db_name())

    # Drop all owned collections from a previous run/test so each test starts clean.
    from pymongo import MongoClient
    pre = MongoClient("mongodb://localhost:27017", serverSelectionTimeoutMS=2000)
    test_db = pre[_test_db_name()]
    for coll in test_db.list_collection_names():
        if coll.startswith("studio_") or coll in ("users", "generation_jobs"):
            test_db[coll].drop()
    pre.close()

    async def _bypass(req, call_next):
        req.state.user = dict(_FAKE_USER)
        return await call_next(req)

    monkeypatch.setattr("modules.auth.auth_middleware", _bypass)


@pytest.fixture
def uploads_dir(tmp_path):
    """Isolated UPLOADS_DIR for each test."""
    d = tmp_path / "uploads"
    d.mkdir()
    return d


@pytest.fixture
def outputs_dir(tmp_path):
    """Isolated OUTPUTS_DIR for each test."""
    d = tmp_path / "outputs"
    d.mkdir()
    return d


@pytest.fixture
def examples_dir(tmp_path):
    """Isolated EXAMPLES_DIR for each test."""
    d = tmp_path / "examples"
    d.mkdir()
    return d
