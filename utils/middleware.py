"""ASGI middleware for Phase 0 security & audit log."""
from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Awaitable, Callable

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

import config

# Endpoints that produce an audit log entry.
# Only state-mutating or resource-accessing paths.
AUDIT_PATH_PREFIXES = (
    "/api/generate",
    "/api/generate-conversation",
    "/api/host/generate",
    "/api/composite/generate",
    "/api/hosts",
    "/api/upload/",
    "/api/queue/",  # DELETE
    "/api/elevenlabs/generate",
    "/api/elevenlabs/clone-voice",
)


class ContentLengthLimit(BaseHTTPMiddleware):
    """Reject 413 before reading body if Content-Length exceeds max."""

    def __init__(self, app, max_bytes: int = config.MAX_UPLOAD_BYTES):
        super().__init__(app)
        self.max_bytes = max_bytes

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        cl = request.headers.get("content-length")
        if cl:
            try:
                if int(cl) > self.max_bytes:
                    return JSONResponse(
                        {"detail": f"Content-Length exceeds {self.max_bytes // 1_000_000}MB"},
                        status_code=413,
                    )
            except ValueError:
                pass
        return await call_next(request)


class ApiKeyAuth(BaseHTTPMiddleware):
    """Conditional X-API-Key check. Activated only when REQUIRE_API_KEY=1 + API_KEY set.

    Allows read-only GETs to /api/config, /api/files, /api/files, /api/queue without key.
    """

    PUBLIC_PREFIXES = ("/api/config", "/api/files", "/static", "/docs", "/openapi.json")

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if not (config.REQUIRE_API_KEY and config.API_KEY):
            return await call_next(request)
        path = request.url.path
        if request.method == "GET" and any(path.startswith(p) for p in self.PUBLIC_PREFIXES):
            return await call_next(request)
        key = request.headers.get("x-api-key", "")
        if key != config.API_KEY:
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        return await call_next(request)


def _hash_ip(ip: str) -> str:
    return hashlib.sha256(ip.encode()).hexdigest()[:16]


class AuditLog(BaseHTTPMiddleware):
    """Append JSON-lines audit entry for mutating endpoints.

    PII allowlist (Phase 0 §4.0.7): timestamp, hashed IP, method, endpoint, status, duration_ms.
    Body params NEVER logged (filenames/voice_ids may contain PII).
    """

    def __init__(self, app, log_path: str = config.AUDIT_LOG_PATH):
        super().__init__(app)
        self.log_path = log_path
        os.makedirs(os.path.dirname(self.log_path), exist_ok=True)

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        path = request.url.path
        should_log = any(path.startswith(p) for p in AUDIT_PATH_PREFIXES)
        if not should_log:
            return await call_next(request)

        start = time.monotonic()
        response = await call_next(request)
        duration_ms = int((time.monotonic() - start) * 1000)

        client_ip = request.client.host if request.client else "unknown"
        entry = {
            "ts": time.time(),
            "ip_hash": _hash_ip(client_ip),
            "method": request.method,
            "path": path,
            "status": response.status_code,
            "duration_ms": duration_ms,
        }
        try:
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError:
            pass  # audit failure must not break request
        return response
