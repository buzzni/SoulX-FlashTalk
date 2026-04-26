"""Studio JWT auth (PR2).

Independent of platform — bcrypt-verifies the password against the existing
`users.hashed_password` and issues a studio-only JWT signed with
`STUDIO_JWT_SECRET`. Logout bumps `studio_token_version`, never touches
platform's `token_version`.

Per docs/db-integration-plan.md decisions #1, #5, #6.

Public surface:
- `login(user_id, password)`               -> {access_token, ...}
- `logout(user_id)`                        -> new studio_token_version
- `me(user)`                               -> sanitized profile
- `auth_middleware(request, call_next)`    -> ASGI middleware
- `PUBLIC_PATHS` / `PUBLIC_PATH_PREFIXES`  -> auth allow-list
"""
from __future__ import annotations

import logging
import time
from typing import Any, Optional

import bcrypt
import jwt
from fastapi import HTTPException
from fastapi.responses import JSONResponse

import config
from modules.repositories import user_repo

logger = logging.getLogger(__name__)


# Plan §6: these stay open. Login is open by definition. /api/config is read by
# the SPA before login. /api/files/* and /api/videos/* are read by <img>/<video>
# tags which can't send Authorization headers (cloud migration → presigned URLs).
PUBLIC_PATHS: set[str] = {
    "/",
    "/api/config",
    "/api/auth/login",
    "/openapi.json",
    "/docs",
    "/redoc",
    "/favicon.ico",
}
PUBLIC_PATH_PREFIXES: tuple[str, ...] = (
    "/api/files/",
    "/api/videos/",   # served through /api/files but kept explicit per plan #10
    "/static/",
    "/assets/",
    "/@vite",         # Vite HMR (only relevant when frontend proxies)
)

JWT_ALGORITHM = "HS256"


def _is_public(path: str) -> bool:
    if path in PUBLIC_PATHS:
        return True
    return any(path.startswith(p) for p in PUBLIC_PATH_PREFIXES)


def _verify_password(plaintext: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plaintext.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def _issue_token(user: dict[str, Any]) -> tuple[str, int]:
    """Return (jwt, expires_in_seconds)."""
    now = int(time.time())
    ttl = config.STUDIO_JWT_TTL_DAYS * 24 * 3600
    payload = {
        "sub": user["user_id"],
        "role": user.get("role", "member"),
        "sid": int(user.get("studio_token_version", 0)),
        "iat": now,
        "exp": now + ttl,
    }
    if not config.STUDIO_JWT_SECRET:
        raise RuntimeError("STUDIO_JWT_SECRET is empty — refusing to issue a token")
    token = jwt.encode(payload, config.STUDIO_JWT_SECRET, algorithm=JWT_ALGORITHM)
    return token, ttl


async def login(user_id: str, password: str) -> dict[str, Any]:
    """Verify credentials, gate on subscription, issue access token.

    Returns: {access_token, token_type, expires_in, user: {...}}.
    Raises HTTPException(401) on any failure (don't leak which check failed).
    """
    if not user_id or not password:
        raise HTTPException(status_code=401, detail="invalid credentials")
    user = await user_repo.find_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="invalid credentials")
    if not user.get("is_active"):
        raise HTTPException(status_code=401, detail="invalid credentials")
    if user.get("approval_status") != "approved":
        raise HTTPException(status_code=401, detail="invalid credentials")
    if "studio" not in (user.get("subscriptions") or []):
        raise HTTPException(status_code=401, detail="invalid credentials")
    if not _verify_password(password, user.get("hashed_password", "")):
        raise HTTPException(status_code=401, detail="invalid credentials")

    token, ttl = _issue_token(user)
    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": ttl,
        "user": _public_user(user),
    }


async def logout(user_id: str) -> int:
    """Invalidate all outstanding studio JWTs for this user. Returns new sid."""
    return await user_repo.bump_studio_token_version(user_id)


def _public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "user_id": user["user_id"],
        "display_name": user.get("display_name", user["user_id"]),
        "role": user.get("role", "member"),
        "subscriptions": user.get("subscriptions") or [],
    }


def me(user: dict[str, Any]) -> dict[str, Any]:
    return _public_user(user)


async def _resolve_user_from_token(token: str) -> dict[str, Any]:
    """Verify JWT + freshness + active state + studio subscription.

    Returns the full user record on success. Raises HTTPException(401|403)
    on any failure.
    """
    if not config.STUDIO_JWT_SECRET:
        raise HTTPException(status_code=503, detail="auth not configured")
    try:
        payload = jwt.decode(token, config.STUDIO_JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="invalid token")

    user_id = payload.get("sub")
    sid = payload.get("sid")
    if not user_id or sid is None:
        raise HTTPException(status_code=401, detail="invalid token")

    user = await user_repo.find_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="user not found")
    if not user.get("is_active") or user.get("approval_status") != "approved":
        raise HTTPException(status_code=401, detail="user disabled")
    # Token-version revocation (per-product, doesn't touch platform's token_version)
    if int(user.get("studio_token_version", 0)) != int(sid):
        raise HTTPException(status_code=401, detail="token revoked")
    # Subscription re-check on every request (decision #5) — admin can pull
    # studio access mid-session and the next request gets a 403.
    if "studio" not in (user.get("subscriptions") or []):
        raise HTTPException(status_code=403, detail="studio access revoked")
    return user


async def auth_middleware(request, call_next):
    """ASGI middleware that gates non-public paths behind a valid studio JWT.

    On success, attaches the user record to `request.state.user`.
    """
    path = request.url.path
    if _is_public(path):
        return await call_next(request)

    auth_header = request.headers.get("authorization", "")
    parts = auth_header.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        return JSONResponse({"detail": "missing or malformed Authorization header"},
                             status_code=401)

    try:
        user = await _resolve_user_from_token(parts[1])
    except HTTPException as exc:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

    request.state.user = user
    return await call_next(request)


def get_request_user(request) -> dict[str, Any]:
    """Helper for endpoints that need the authenticated user record."""
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(status_code=500, detail="auth middleware did not run")
    return user
