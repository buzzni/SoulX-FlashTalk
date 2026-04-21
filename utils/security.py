"""Security helpers for Phase 0: path-traversal guard, upload validation.

All body-field paths and /api/files requests MUST pass through `safe_upload_path`.
"""
from __future__ import annotations

import os
from typing import Iterable, Optional

from fastapi import HTTPException

import config


def safe_upload_path(path: str, roots: Optional[Iterable[str]] = None) -> str:
    """Return realpath if it resolves inside one of the allowed roots.

    Raises HTTPException(400) otherwise. Strictly rejects:
    - absolute paths outside SAFE_ROOTS (e.g., /etc/passwd)
    - relative paths that resolve via .. into parent dirs
    - symlinks pointing outside the roots (os.path.realpath resolves them)

    Phase 0 CSO Critical #2 fix. Applies to 14+ endpoints (see plan.md §4.0.3).

    Note: resolves `config.SAFE_ROOTS` on every call (not at import time) so that
    test monkeypatching of config paths works correctly.
    """
    if not path:
        raise HTTPException(status_code=400, detail="Empty path")

    # Resolve any symlinks + normalize
    try:
        resolved = os.path.realpath(path)
    except (OSError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid path")

    effective_roots = roots if roots is not None else config.SAFE_ROOTS
    for root in effective_roots:
        root_resolved = os.path.realpath(root)
        # Ensure trailing separator to avoid '/foo' matching '/foobar'
        if resolved == root_resolved or resolved.startswith(root_resolved + os.sep):
            return resolved

    raise HTTPException(status_code=400, detail="Path is not inside allowed directory")


def validate_image_upload(file_path: str, max_bytes: int = config.MAX_UPLOAD_BYTES) -> None:
    """Verify file is a real image under size cap.

    Phase 0: magic-byte via PIL.Image.verify() + size check.
    Raises HTTPException(400|413) on failure.
    """
    # Size check
    try:
        size = os.path.getsize(file_path)
    except OSError:
        raise HTTPException(status_code=400, detail="File unreadable")
    if size > max_bytes:
        raise HTTPException(status_code=413, detail=f"File exceeds {max_bytes // 1_000_000}MB limit")

    # Magic-byte via Pillow
    try:
        from PIL import Image

        with Image.open(file_path) as im:
            im.verify()  # raises on corrupt/non-image
    except Exception:
        raise HTTPException(status_code=400, detail="Not a valid image file")


def validate_audio_upload(file_path: str, max_bytes: int = config.MAX_UPLOAD_BYTES) -> None:
    """Verify file is a real audio/video via ffprobe + size check."""
    try:
        size = os.path.getsize(file_path)
    except OSError:
        raise HTTPException(status_code=400, detail="File unreadable")
    if size > max_bytes:
        raise HTTPException(status_code=413, detail=f"File exceeds {max_bytes // 1_000_000}MB limit")

    # ffprobe existence as magic-byte equivalent
    import subprocess

    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_type", "-of", "default=noprint_wrappers=1:nokey=1",
             file_path],
            capture_output=True, text=True, timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        # ffprobe missing or hung — treat as validation failure
        raise HTTPException(status_code=500, detail="Audio validation unavailable")

    if result.returncode != 0 or "audio" not in (result.stdout or ""):
        raise HTTPException(status_code=400, detail="Not a valid audio file")


def enforce_content_length(content_length: int | None, max_bytes: int = config.MAX_UPLOAD_BYTES) -> None:
    """Pre-check Content-Length header. Reject 413 before body read."""
    if content_length is not None and content_length > max_bytes:
        raise HTTPException(status_code=413, detail=f"Content-Length exceeds {max_bytes // 1_000_000}MB")
