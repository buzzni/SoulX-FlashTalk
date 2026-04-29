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
                    "test_studio_result_repo",
                    "test_db_connection", "test_user_repo",
                    "test_studio_006_add_subscriptions", "test_storage_local",
                    "test_storage_s3",
                    "test_studio_007_local_import"):
        return

    # Redirect DB so api-level tests don't pollute the dev `ai_showhost`.
    # The TestClient's startup hook reads config.DB_NAME at fire time, so
    # patching here (before the client is constructed) takes effect.
    monkeypatch.setattr("config.MONGO_URL", "mongodb://localhost:27017")
    monkeypatch.setattr("config.DB_NAME", _test_db_name())

    # Suppress S3 cutover during tests — the startup hook flips
    # media_store to S3MediaStore when both creds are non-empty (PR
    # S3+ C13). LocalDisk is the assumption every API test fixture is
    # built around (uploads_dir / outputs_dir tmp_path roots, real
    # disk reads in assertions). Tests that exercise S3 explicitly
    # use the s3_media_store_swap fixture instead.
    monkeypatch.setattr("config.S3_ACCESS_KEY", "")
    monkeypatch.setattr("config.S3_SECRET_KEY", "")

    # Drop all owned collections from a previous run/test so each test starts clean.
    from pymongo import MongoClient
    pre = MongoClient("mongodb://localhost:27017", serverSelectionTimeoutMS=2000)
    test_db = pre[_test_db_name()]
    for coll in test_db.list_collection_names():
        if coll.startswith("studio_") or coll == "users":
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


# ── S3 / moto fixtures (PR S3+) ───────────────────────────────────
#
# These are NOT autouse — they only activate when a test explicitly
# depends on them. The default backend stays LocalDisk so existing
# tests (uploads_dir / outputs_dir / examples_dir) keep working
# unchanged. Tests opting into S3 take `s3_media_store` (raw store)
# or `s3_media_store_swap` (also monkeypatches the singleton so
# application code transparently uses S3).
#
# Function-scoped: each test gets a fresh in-process moto bucket.
# Module-scoped fixtures sound faster but leak object state across
# tests — flakiness for a savings of ~5ms/test isn't worth it.

_S3_TEST_BUCKET = "ailab-demo"
_S3_TEST_ENV = "dev"
_S3_TEST_PROJECT = "soulx-flashtalk"


@pytest.fixture
def s3_mock():
    """Activate moto's mock_aws for the duration of the test."""
    from moto import mock_aws
    with mock_aws():
        yield


@pytest.fixture
def s3_client(s3_mock):
    """boto3 S3 client backed by moto, with `ailab-demo` bucket created."""
    import boto3
    client = boto3.client("s3", region_name="us-east-1")
    client.create_bucket(Bucket=_S3_TEST_BUCKET)
    return client


@pytest.fixture
def s3_media_store(s3_client):
    """`S3MediaStore` backed by moto. Use this when the test exercises
    the S3 backend directly. End-to-end tests that need the *application*
    to pick up an S3 backend should depend on `s3_media_store_swap`
    instead — that one also monkeypatches the module-level singleton."""
    from modules.storage_s3 import S3MediaStore
    return S3MediaStore(
        bucket=_S3_TEST_BUCKET,
        env_prefix=_S3_TEST_ENV,
        project=_S3_TEST_PROJECT,
        client=s3_client,
    )


@pytest.fixture
def s3_media_store_swap(monkeypatch, s3_media_store):
    """Like `s3_media_store` but also points `modules.storage.media_store`
    at the moto-backed instance. Application code under test then uses
    the S3 backend transparently. Cleanup (singleton restore) is
    automatic via monkeypatch at test exit.

    IMPORT PATTERN CONSTRAINT: callers under test must access the
    singleton through the module attribute (`from modules import storage
    as _storage; _storage.media_store.X`) — `from modules.storage import
    media_store` re-binds the name at import time and would silently
    bypass this swap. All current callsites in app.py and modules/repos
    follow the safe pattern; lint/grep should flag the unsafe one.
    """
    monkeypatch.setattr("modules.storage.media_store", s3_media_store)
    return s3_media_store


# Backwards-compat alias so existing `test_storage_s3.py` tests can keep
# their `s3_setup` parameter name without redefining moto state inside
# that file. New S3-backed tests should depend on `s3_client` /
# `s3_media_store` (or `s3_media_store_swap`) directly — that pair is
# the long-lived API.
@pytest.fixture
def s3_setup(s3_client, s3_media_store):
    return s3_client, s3_media_store
