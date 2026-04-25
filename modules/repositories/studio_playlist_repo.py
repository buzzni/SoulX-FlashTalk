"""studio_playlists collection — per-user playlists for grouping generated videos.

Per docs/playlist-feature-plan.md §3 and §5. Membership is single (one video
belongs to 0 or 1 playlist), stored on studio_results.playlist_id (decision #1).

Schema:
    {
      _id, user_id,
      playlist_id,                  // 32-char hex uuid; stable reference
      name,                         // user-facing label
      name_normalized,              // NFC + strip + casefold for uniqueness
      created_at, updated_at,
    }

Indexes (in modules/db.py::init_indexes):
- {user_id:1, playlist_id:1} unique
- {user_id:1, name_normalized:1} unique

Delete cascade order: clear videos to null first, then drop the playlist row
(plan §5 + §10.7). Recovery semantics: re-running delete is idempotent on
already-cleared rows and removes the orphan playlist row.
"""
from __future__ import annotations

import logging
import unicodedata
import uuid
from datetime import datetime, timezone
from typing import Optional

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from modules import db as db_module
from modules.repositories import studio_result_repo

logger = logging.getLogger(__name__)


# Reserved names map onto the synthetic "미지정" bucket; users can't shadow it.
RESERVED_NORMALIZED = frozenset({"미지정", "unassigned"})


class DuplicateNameError(ValueError):
    """Raised when (user_id, name_normalized) already exists."""


class ReservedNameError(ValueError):
    """Raised when the user tries to use a reserved name (미지정/unassigned)."""


def _coll():
    return db_module.get_db().studio_playlists


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _normalize(name: str) -> str:
    return unicodedata.normalize("NFC", name).strip().casefold()


def _public(doc: dict, *, video_count: int = 0) -> dict:
    return {
        "playlist_id": doc["playlist_id"],
        "name": doc["name"],
        "created_at": doc.get("created_at"),
        "updated_at": doc.get("updated_at"),
        "video_count": video_count,
    }


# ── Writes ───────────────────────────────────────────────────────────


async def create(user_id: str, *, name: str) -> dict:
    """Insert a new playlist. Returns its public dict (video_count=0).

    Raises:
        ValueError: when name is empty after normalization.
        ReservedNameError: when normalized name is reserved.
        DuplicateNameError: when (user_id, name_normalized) already exists.
    """
    if not user_id:
        raise ValueError("create requires user_id")
    normalized = _normalize(name)
    if not normalized:
        raise ValueError("playlist name cannot be empty")
    if normalized in RESERVED_NORMALIZED:
        raise ReservedNameError(f"'{name}' is a reserved name")
    now = _now()
    doc = {
        "user_id": user_id,
        "playlist_id": uuid.uuid4().hex,
        "name": name.strip(),
        "name_normalized": normalized,
        "created_at": now,
        "updated_at": now,
    }
    try:
        await _coll().insert_one(doc)
    except DuplicateKeyError as e:
        raise DuplicateNameError(
            f"playlist '{name.strip()}' already exists for this user"
        ) from e
    return _public(doc, video_count=0)


async def rename(user_id: str, playlist_id: str, *, name: str) -> Optional[dict]:
    """Rename. Returns updated public dict, or None if missing/cross-user.

    Raises:
        ValueError: when name is empty after normalization.
        ReservedNameError: when normalized name is reserved.
        DuplicateNameError: when the new normalized name collides.
    """
    normalized = _normalize(name)
    if not normalized:
        raise ValueError("playlist name cannot be empty")
    if normalized in RESERVED_NORMALIZED:
        raise ReservedNameError(f"'{name}' is a reserved name")
    try:
        doc = await _coll().find_one_and_update(
            {"user_id": user_id, "playlist_id": playlist_id},
            {"$set": {
                "name": name.strip(),
                "name_normalized": normalized,
                "updated_at": _now(),
            }},
            return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError as e:
        raise DuplicateNameError(
            f"playlist '{name.strip()}' already exists for this user"
        ) from e
    return _public(doc) if doc else None


async def delete(user_id: str, playlist_id: str) -> bool:
    """Cascade videos to "미지정" first, then drop playlist row.
    Returns False if missing/cross-user (no rows touched in either op).

    Plan §5: clear→drop ordering keeps state always-consistent. Worst case
    (clear succeeds, drop fails) leaves an orphan empty playlist row that a
    delete retry idempotently cleans up.
    """
    # Verify ownership before mutating studio_results — we don't want
    # clear_playlist_id to no-op on someone else's playlist_id by accident.
    if not await exists(user_id, playlist_id):
        return False
    await studio_result_repo.clear_playlist_id(user_id, playlist_id)
    res = await _coll().delete_one({"user_id": user_id, "playlist_id": playlist_id})
    return res.deleted_count > 0


# ── Reads ────────────────────────────────────────────────────────────


async def exists(user_id: str, playlist_id: str) -> bool:
    """Sole ownership check (plan decision #9). Cross-user / missing → False."""
    doc = await _coll().find_one(
        {"user_id": user_id, "playlist_id": playlist_id},
        projection={"_id": 1},
    )
    return doc is not None


async def get(user_id: str, playlist_id: str) -> Optional[dict]:
    doc = await _coll().find_one({"user_id": user_id, "playlist_id": playlist_id})
    return _public(doc) if doc else None


async def list_for_user(user_id: str) -> list[dict]:
    """List all playlists for user with video_count via $group aggregation.
    Sidebar applies alphabetical sort in JS (plan decision #11).

    video_count counts only completed videos (matches /api/history filter
    behavior — sidebar count == what the filtered list would show).
    """
    playlists = [d async for d in _coll().find({"user_id": user_id})]
    pipeline = [
        {"$match": {
            "user_id": user_id,
            "status": "completed",
            "playlist_id": {"$ne": None},
        }},
        {"$group": {"_id": "$playlist_id", "count": {"$sum": 1}}},
    ]
    counts: dict[str, int] = {}
    async for row in db_module.get_db().studio_results.aggregate(pipeline):
        counts[row["_id"]] = row["count"]
    return [_public(p, video_count=counts.get(p["playlist_id"], 0)) for p in playlists]


async def count_for_user(user_id: str) -> int:
    return await _coll().count_documents({"user_id": user_id})


async def unassigned_count(user_id: str) -> int:
    """Count of completed videos with no playlist (playlist_id null or absent).
    Powers the synthetic "미지정" sidebar count."""
    return await db_module.get_db().studio_results.count_documents({
        "user_id": user_id,
        "status": "completed",
        "playlist_id": None,  # mongo: matches both null and missing field
    })
