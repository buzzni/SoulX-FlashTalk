"""studio_saved_hosts collection — user library of long-lived host avatars.

Decision #4 split this from candidate hosts (studio_hosts). Saved hosts have
a different lifecycle: they're created from /api/hosts/save (POST), listed
via /api/hosts (GET), renamed via /api/hosts/{host_id} (PATCH), and
soft-deleted via /api/hosts/{host_id} (DELETE). No draft/selected/committed
state machine.

Schema (matches docs/db-integration-plan.md §4.2 + saved-host eng-review
2026-04-29 additions for rename + soft-delete):

    {
      _id, user_id, host_id, name, storage_key,
      meta: { ...optional generation metadata at save time... },
      created_at,
      updated_at,                # set on rename (PATCH)
      deleted_at,                # set on soft-delete; None for live rows
    }

Lifecycle (decision #10 — soft-delete):
- create(): inserts with deleted_at unset.
- list_for_user() / get(): both filter `deleted_at: None`.
- update_name(): rejects rows with `deleted_at` set (treats deleted as
  not-found).
- delete(): sets `deleted_at = now()` instead of removing the row. The
  backing file stays in storage; a cron worker (out of scope for this PR)
  GCs files older than the retention window. This means an active wizard
  draft that already injected a saved host can keep generating during
  the retention window even if another tab clicked delete.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from modules import db as db_module
from modules import storage as storage_module


def _coll():
    return db_module.get_db().studio_saved_hosts


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _live_filter(user_id: str, host_id: Optional[str] = None) -> dict:
    """Mongo filter scoping by user + excluding soft-deleted rows.

    Why a helper: every read/update path needs the same `deleted_at: None`
    guard. Centralised here so a future schema migration (e.g. switching
    from `deleted_at: None` to a Mongo TTL marker) only touches one spot.
    """
    f: dict = {"user_id": user_id, "deleted_at": None}
    if host_id is not None:
        f["host_id"] = host_id
    return f


def _iso(value: Any) -> Optional[str]:
    """Coerce a stored datetime to ISO 8601, leave strings alone, drop None.

    Matches the convention used elsewhere (see app.py datetime handling
    around manifest `completed_at`). modules.schemas.SavedHost types
    these as `Optional[str]`, so the response_model layer would 500 on
    a raw datetime.
    """
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _public(doc: dict) -> dict:
    """API-shape projection — keys mirror modules.schemas.SavedHost.

    Includes updated_at + deleted_at so the response model can surface
    rename activity. URL signing uses the live storage_key even on
    soft-deleted rows so a cleanup tool that lists deleted rows can
    still display them; live read paths exclude them via _live_filter.
    """
    key = doc.get("key") or doc.get("storage_key") or ""
    try:
        url = storage_module.media_store.url_for(key) if key else ""
    except ValueError:
        url = ""
    out: dict[str, Any] = {
        "id": doc["host_id"],
        "name": doc.get("name", ""),
        "key": key,
        "url": url,
        "created_at": _iso(doc.get("created_at")),
        "updated_at": _iso(doc.get("updated_at")),
        "deleted_at": _iso(doc.get("deleted_at")),
    }
    if doc.get("meta"):
        out["meta"] = doc["meta"]
    return out


async def create(
    user_id: str,
    *,
    host_id: str,
    name: str,
    storage_key: str,
    meta: Optional[dict] = None,
) -> dict:
    """Persist a saved host. Idempotent on (user_id, host_id).

    Re-saving with the same host_id refreshes name/storage_key/meta but
    keeps the original created_at. Does NOT clear `deleted_at` — once a
    row is soft-deleted, save_host generates a fresh host_id (uuid4) so
    save flows can't accidentally resurrect a tombstone.
    """
    update = {
        "user_id": user_id,
        "host_id": host_id,
        "name": name,
        "storage_key": storage_key,
    }
    if meta is not None:
        update["meta"] = meta
    await _coll().update_one(
        {"user_id": user_id, "host_id": host_id},
        {
            "$set": update,
            "$setOnInsert": {
                "created_at": _now(),
                "deleted_at": None,
            },
        },
        upsert=True,
    )
    doc = await _coll().find_one({"user_id": user_id, "host_id": host_id})
    return _public(doc)


async def list_for_user(user_id: str) -> list[dict]:
    """Live rows for `user_id`, newest first. Soft-deleted rows hidden."""
    cursor = _coll().find(_live_filter(user_id)).sort("created_at", -1)
    return [_public(d) async for d in cursor]


async def get(user_id: str, host_id: str) -> Optional[dict]:
    """Single live row or None. Soft-deleted rows return None."""
    doc = await _coll().find_one(_live_filter(user_id, host_id))
    return _public(doc) if doc else None


async def update_name(user_id: str, host_id: str, name: str) -> Optional[dict]:
    """Rename a live saved host. Returns the updated _public doc, or None
    if the row doesn't exist or was soft-deleted.

    `name` is expected to be already-validated (Pydantic SavedHostName
    constrains 1..100 chars trimmed) — repo doesn't re-validate.
    """
    from pymongo import ReturnDocument

    doc = await _coll().find_one_and_update(
        _live_filter(user_id, host_id),
        {"$set": {"name": name, "updated_at": _now()}},
        return_document=ReturnDocument.AFTER,
    )
    return _public(doc) if doc else None


async def delete(user_id: str, host_id: str) -> bool:
    """Soft-delete: set deleted_at, keep row + backing file.

    Returns False if the row doesn't exist or is already deleted (i.e.
    the request was a no-op). The backing file stays — a cron sweeps
    files older than the retention window. See module docstring.
    """
    doc = await _coll().find_one_and_update(
        _live_filter(user_id, host_id),
        {"$set": {"deleted_at": _now()}},
    )
    return doc is not None
