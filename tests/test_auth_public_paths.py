"""_is_public unit tests — gate write methods on read-only public prefixes.

Regression: before commit fixing this, /api/videos/* was public for ALL
methods because <video> tags can't send Authorization headers. That meant
DELETE /api/videos/{task_id} bypassed auth_middleware entirely, and the
endpoint then 500'd at get_request_user("auth middleware did not run").
Side note: it was also a small security gap — anyone who knew a task_id
could delete it. Splitting the prefix into GET-only fixes both.
"""
from __future__ import annotations

import pytest

from modules.auth import _is_public


# ── Fully public paths (every method) ──────────────────────────────

@pytest.mark.parametrize("path", [
    "/",
    "/api/config",
    "/api/auth/login",
    "/openapi.json",
    "/docs",
    "/favicon.ico",
])
@pytest.mark.parametrize("method", ["GET", "POST", "DELETE", "PATCH"])
def test_fully_public_paths_allow_every_method(path, method):
    assert _is_public(path, method) is True


@pytest.mark.parametrize("path", ["/static/x.css", "/assets/y.png", "/@vite/client"])
@pytest.mark.parametrize("method", ["GET", "POST"])
def test_fully_public_prefixes_allow_every_method(path, method):
    assert _is_public(path, method) is True


# ── GET-only public prefixes — read open, writes go through auth ──

@pytest.mark.parametrize("path", [
    "/api/videos/abc123",
    "/api/files/outputs/hosts/saved/x.png",
])
@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_get_only_prefixes_allow_reads(path, method):
    assert _is_public(path, method) is True


@pytest.mark.parametrize("path", [
    "/api/videos/abc123",
    "/api/files/outputs/hosts/saved/x.png",
])
@pytest.mark.parametrize("method", ["POST", "DELETE", "PATCH", "PUT"])
def test_get_only_prefixes_block_writes(path, method):
    """Without this, DELETE /api/videos/{task_id} bypassed auth."""
    assert _is_public(path, method) is False


# ── Authenticated paths stay authenticated ─────────────────────────

@pytest.mark.parametrize("path", [
    "/api/history",
    "/api/playlists",
    "/api/results/abc123",
    "/api/results/abc123/playlist",
    "/api/queue",
])
@pytest.mark.parametrize("method", ["GET", "POST", "DELETE", "PATCH"])
def test_authenticated_paths_never_public(path, method):
    assert _is_public(path, method) is False


# ── Default method (no arg) is GET-permissive (back-compat) ───────

def test_default_method_treats_as_get():
    """Older callers may pass just the path; default kwarg is "GET"
    so the read-only prefixes still resolve as public without a method
    argument."""
    assert _is_public("/api/videos/abc") is True
    assert _is_public("/api/files/x.png") is True
