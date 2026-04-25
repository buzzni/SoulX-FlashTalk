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

Public surface mirrors how lifecycle.py exposed result data: scope-by-user
for the SPA's `/result/:taskId` and `/history` pages, plus a
non-scoped `find_by_task_id` helper used by the public /api/videos/{task_id}
GET endpoint (plan §6: that endpoint is public so <video> tags work).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

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
    """
    if not user_id:
        raise ValueError("upsert requires user_id")
    task_id = manifest.get("task_id")
    if not task_id:
        raise ValueError("upsert requires manifest.task_id")
    set_doc = dict(manifest)
    set_doc["user_id"] = user_id
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


async def list_completed(user_id: str, *, limit: int = 50) -> list[dict]:
    """Return up to `limit` completed manifests for `user_id`,
    newest first. Powers /api/history."""
    cursor = (_coll()
              .find({"user_id": user_id, "status": "completed"},
                    projection={"_id": 0, "_imported_at": 0})
              .sort("completed_at", -1)
              .limit(limit))
    return [d async for d in cursor]


async def count_for_user(user_id: str) -> int:
    return await _coll().count_documents({"user_id": user_id})
