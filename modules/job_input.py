"""Validation + canonicalization helpers for POST /api/jobs.

Two responsibilities:
1. Walk the per-kind input dict, run safe_upload_path on every path field
   so a malicious client can't inject /etc/passwd through the JSON body
   (eng-spec §8). Sanitized paths replace the originals in the stored blob,
   so worker-side replay reads the same canonical paths the API saw.
2. Compute a stable input_hash for dedupe-by-reuse (eng-spec §6.5). The
   hash is sha256 over a canonical JSON serialization (sorted keys, None
   omitted, datetime → isoformat) of the sanitized blob.

Size cap (eng-spec §7): the canonical JSON must fit in 256KB or the API
returns 413 before insertion.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any

from fastapi import HTTPException

from utils.security import safe_upload_path


# Eng-spec §7: input_blob serialized JSON must fit under this cap.
INPUT_BLOB_MAX_BYTES = 256_000

# Path fields per kind. Step 4 will add the composite kind's path fields
# (faceRefPath, outfitRefPath, styleRefPath, productPath, etc.) to this map.
_PATH_FIELDS_BY_KIND: dict[str, tuple[str, ...]] = {
    "host": ("faceRefPath", "outfitRefPath", "styleRefPath"),
}


def _json_default(obj: Any) -> Any:
    """JSON serializer fallback for types json.dumps doesn't know natively."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def _canonicalize(blob: dict[str, Any]) -> dict[str, Any]:
    """Drop None values and sort recursively so the resulting dict has a
    deterministic shape regardless of insertion order. The input_hash is
    computed over the JSON of this dict — drift here would break dedupe."""
    out: dict[str, Any] = {}
    for k in sorted(blob):
        v = blob[k]
        if v is None:
            continue
        if isinstance(v, dict):
            v = _canonicalize(v)
            if not v:
                continue
        out[k] = v
    return out


def validate_and_sanitize(kind: str, raw: dict[str, Any]) -> dict[str, Any]:
    """Sanitize path fields per kind and return the canonical input blob.

    Raises HTTPException(400) on any invalid path (delegated from
    safe_upload_path). Unknown `kind` raises HTTPException(400)."""
    path_fields = _PATH_FIELDS_BY_KIND.get(kind)
    if path_fields is None:
        raise HTTPException(
            status_code=400, detail=f"unsupported kind: {kind!r}"
        )

    sanitized = dict(raw)
    for field in path_fields:
        val = sanitized.get(field)
        if val:
            sanitized[field] = safe_upload_path(val)
    return _canonicalize(sanitized)


def compute_input_hash(blob: dict[str, Any]) -> str:
    """sha256 of canonical JSON. Caller has already passed `blob` through
    validate_and_sanitize, so it's already canonical — but we re-serialize
    here with sort_keys=True as a belt-and-braces guarantee that any future
    drift in _canonicalize doesn't silently break the dedupe key."""
    payload = json.dumps(
        blob, sort_keys=True, ensure_ascii=False, default=_json_default,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def enforce_size_cap(blob: dict[str, Any]) -> None:
    """Raise HTTPException(413) if the canonical JSON exceeds 256KB.

    Eng-spec §7 — the cap is on the serialized form, not the dict size,
    because Mongo's BSON encoding can blow up on deeply nested or large
    base64'd payloads."""
    payload = json.dumps(blob, sort_keys=True, ensure_ascii=False,
                         default=_json_default)
    size = len(payload.encode("utf-8"))
    if size > INPUT_BLOB_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(f"input too large ({size} bytes; "
                    f"limit {INPUT_BLOB_MAX_BYTES})"),
        )
