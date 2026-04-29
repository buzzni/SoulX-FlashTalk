"""studio_saved_hosts collection — user library of long-lived host avatars.

Decision #4 split this from candidate hosts (studio_hosts). Saved hosts have
a different lifecycle: they're created from /api/hosts/save (POST), listed
via /api/hosts (GET), and deleted via /api/hosts/{host_id} (DELETE). No
draft/selected/committed state machine.

Schema (matches docs/db-integration-plan.md §4.2):
    {
      _id, user_id, host_id, name, storage_key,
      meta: { ...optional generation metadata at save time... },
      created_at,
    }
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


def _public(doc: dict) -> dict:
    """API-shape projection. Adds `storage_key` (stable, PR S3+) and
    legacy-compat `path` / `url` derived from storage_key. After C9
    the frontend reads `storage_key`; `path` is left intact for the
    transition."""
    key = doc.get("storage_key", "")
    try:
        url = storage_module.media_store.url_for(key) if key else ""
    except ValueError:
        url = ""
    path = storage_module.legacy_path_for(key)
    out: dict[str, Any] = {
        "id": doc["host_id"],
        "name": doc.get("name", ""),
        "storage_key": key,
        "path": path,
        "url": url,
        "created_at": doc.get("created_at"),
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
    """Persist a saved host. Idempotent on (user_id, host_id) — second
    call updates name/storage_key/meta and refreshes created_at-on-insert.
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
        {"$set": update, "$setOnInsert": {"created_at": _now()}},
        upsert=True,
    )
    doc = await _coll().find_one({"user_id": user_id, "host_id": host_id})
    return _public(doc)


async def list_for_user(user_id: str) -> list[dict]:
    cursor = _coll().find({"user_id": user_id}).sort("created_at", -1)
    return [_public(d) async for d in cursor]


async def get(user_id: str, host_id: str) -> Optional[dict]:
    doc = await _coll().find_one({"user_id": user_id, "host_id": host_id})
    return _public(doc) if doc else None


async def delete(user_id: str, host_id: str) -> bool:
    """Delete a saved host: row + backing file. Returns False if not found."""
    doc = await _coll().find_one_and_delete({"user_id": user_id, "host_id": host_id})
    if doc is None:
        return False
    key = doc.get("storage_key")
    if key:
        try:
            storage_module.media_store.delete(key)
        except (ValueError, OSError):
            pass  # row gone is what matters; file cleanup is best-effort
    return True
