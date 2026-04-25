"""Shared pytest fixtures for HostStudio migration tests."""
from __future__ import annotations

import pytest


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
