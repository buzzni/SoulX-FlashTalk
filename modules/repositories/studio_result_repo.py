"""studio_results collection — generation result manifests.

Replaces the legacy outputs/results/{task_id}.json sidecars and
outputs/video_history.json. Per docs/db-integration-plan.md §4.3.

Schema (matches plan §4.3):
    {
      _id, user_id, task_id,
      type, status,                      // "generate"/"regenerate"; "completed"/"failed"/"running"
      video_storage_key, video_bytes,
      generation_time_sec, completed_at,
      params: { ...all generation params with paths normalized to storage_keys },
      meta:   { host:{...}, composition:{...}, products:[...], background:{...}, voice:{...} },
      error,                              // optional, when status="failed"
    }

Indexes (created in modules/db.py:init_indexes):
- {user_id:1, task_id:1} unique
- {user_id:1, status:1, completed_at:-1}

Public surface: scope-by-user for the SPA's `/result/:taskId` and `/history`
pages, plus a non-scoped `find_by_task_id` helper used by the public
/api/videos/{task_id} GET endpoint (plan §6: that endpoint is public so
<video> tags work).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from pymongo import ReturnDocument

from modules import db as db_module

logger = logging.getLogger(__name__)


def _coll():
    return db_module.get_db().studio_results


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Writes ───────────────────────────────────────────────────────────

async def upsert(user_id: str, manifest: dict) -> None:
    """Insert or update a result manifest by (user_id, task_id).

    `manifest` is the full payload — task_id/type/status/params/meta/...
    Caller is responsible for normalizing absolute paths to storage_keys
    before passing it in (the repo does no path scrubbing).

    Plan decision #9: if `manifest.playlist_id` references a missing or
    cross-user playlist, silently coerce it to null. This is the worker
    race-recovery path (user deletes playlist mid-render). The PATCH
    endpoint takes a stricter path (404 on miss).
    """
    if not user_id:
        raise ValueError("upsert requires user_id")
    task_id = manifest.get("task_id")
    if not task_id:
        raise ValueError("upsert requires manifest.task_id")
    set_doc = dict(manifest)
    set_doc["user_id"] = user_id

    raw_playlist_id = set_doc.get("playlist_id")
    if raw_playlist_id is not None:
        # Late import to avoid circular dependency.
        from modules.repositories import studio_playlist_repo
        if not await studio_playlist_repo.exists(user_id, raw_playlist_id):
            logger.warning(
                "upsert: playlist_id %s not found for user %s — coercing to null",
                raw_playlist_id, user_id,
            )
            set_doc["playlist_id"] = None

    await _coll().update_one(
        {"user_id": user_id, "task_id": task_id},
        {"$set": set_doc, "$setOnInsert": {"_imported_at": _now()}},
        upsert=True,
    )


async def delete(user_id: str, task_id: str) -> bool:
    """Delete a result row owned by user_id. Returns False if not found
    (or owned by someone else)."""
    res = await _coll().delete_one({"user_id": user_id, "task_id": task_id})
    return res.deleted_count > 0


async def clear_playlist_id(user_id: str, playlist_id: str) -> int:
    """Set playlist_id=null on all studio_results owned by user_id with the
    given playlist_id. Returns count of modified docs.

    Used by studio_playlist_repo.delete() cascade (plan §5). Bulk update is
    safe because (user_id, playlist_id) is owner-scoped.
    """
    res = await _coll().update_many(
        {"user_id": user_id, "playlist_id": playlist_id},
        {"$set": {"playlist_id": None}},
    )
    return res.modified_count


# ── Reads ────────────────────────────────────────────────────────────

async def get(user_id: str, task_id: str) -> Optional[dict]:
    """Return the manifest for (user_id, task_id), or None."""
    doc = await _coll().find_one({"user_id": user_id, "task_id": task_id},
                                   projection={"_id": 0, "_imported_at": 0})
    return doc


async def find_by_task_id(task_id: str) -> Optional[dict]:
    """Look up by task_id with NO user filter. Used by the public
    /api/videos/{task_id} GET endpoint where <video> tags can't send
    Authorization headers (plan §6, decisions #10).

    Anyone with a task_id can resolve the video file. This is the same
    leak surface we accepted for the public-files boundary.
    """
    doc = await _coll().find_one({"task_id": task_id},
                                   projection={"_id": 0, "_imported_at": 0})
    return doc


async def list_completed(
    user_id: str,
    *,
    limit: int = 50,
    playlist_id: Optional[str] = None,
) -> list[dict]:
    """Return up to `limit` completed manifests for `user_id`, newest first.

    Powers /api/history. `playlist_id` filter:
        None         → no filter (all playlists + unassigned)
        "unassigned" → playlist_id is null or absent (matches default)
        <hex id>     → exact match. Plan decision #12: unknown id → empty list,
                       NOT 404 (the SPA may filter on a stale id from another
                       tab and we don't want to break filter-UI restoration).
    """
    query: dict[str, Any] = {"user_id": user_id, "status": "completed"}
    if playlist_id is not None:
        if playlist_id == "unassigned":
            query["playlist_id"] = None  # matches both null value and missing field
        else:
            query["playlist_id"] = playlist_id
    cursor = (_coll()
              .find(query, projection={"_id": 0, "_imported_at": 0})
              .sort("completed_at", -1)
              .limit(limit))
    return [d async for d in cursor]


async def set_playlist(
    user_id: str,
    task_id: str,
    playlist_id: Optional[str],
) -> Optional[dict]:
    """Move a result row to `playlist_id` (or null = 미지정).

    Plan §9: validates target via studio_playlist_repo.exists. PATCH endpoint
    surfaces LookupError as 404 (whereas the worker manifest upsert path
    silently coerces to null — that lives in upsert(), not here).

    Args:
        playlist_id: target playlist hex id, or None to unassign.

    Raises:
        LookupError: when playlist_id is non-None and doesn't exist for user_id.

    Returns:
        Updated manifest, or None if (user_id, task_id) doesn't exist.
    """
    if playlist_id is not None:
        # Late import to avoid circular dependency
        # (studio_playlist_repo imports studio_result_repo for clear_playlist_id).
        from modules.repositories import studio_playlist_repo
        if not await studio_playlist_repo.exists(user_id, playlist_id):
            raise LookupError(f"playlist {playlist_id} not found for user {user_id}")
    doc = await _coll().find_one_and_update(
        {"user_id": user_id, "task_id": task_id},
        {"$set": {"playlist_id": playlist_id}},
        return_document=ReturnDocument.AFTER,
        projection={"_id": 0, "_imported_at": 0},
    )
    return doc


async def count_for_user(user_id: str) -> int:
    return await _coll().count_documents({"user_id": user_id})
