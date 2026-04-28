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
import re
from datetime import datetime, timezone
from typing import Any, Optional

from pymongo import ReturnDocument

from modules import db as db_module

logger = logging.getLogger(__name__)


def _coll():
    return db_module.get_db().studio_results


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Public error mapping (plan decision #22) ─────────────────────────
#
# Worker exceptions can leak file paths, stack traces, internal codes.
# The library page surfaces `public_error` instead — Korean user-facing
# messages mapped from known patterns. Raw `error` is preserved on the
# row but only exposed via /api/results/{id} (admin-readable).
#
# When a new failure pattern surfaces in production, add a row here
# rather than parsing it on the frontend.
_ERROR_MAP: list[tuple[re.Pattern, str]] = [
    (re.compile(r"CUDA out of memory|OOM", re.I),
        "서버가 바쁜 상태입니다. 잠시 후 다시 시도해 주세요."),
    (re.compile(r"audio.*not found|audio.*missing|음성.*찾을 수 없", re.I),
        "음성 파일을 찾을 수 없어요. 파일이 삭제됐을 수 있어요."),
    (re.compile(r"audio.*too long|duration.*exceed|음성.*너무 길", re.I),
        "음성 파일이 너무 길어요. 30초 이하로 잘라 주세요."),
    (re.compile(r"image.*not found|host_image.*missing|이미지.*찾을 수 없", re.I),
        "쇼호스트 이미지를 찾을 수 없어요."),
    (re.compile(r"output.*not.*generated|output.*missing|출력 파일이 생성되지", re.I),
        "영상 생성에 실패했어요. 다시 시도해 보세요."),
    (re.compile(r"timeout|deadline|시간 초과", re.I),
        "처리 시간이 너무 오래 걸려서 중단됐어요."),
    (re.compile(r"cancelled by user|user.*cancel|사용자가 취소", re.I),
        "사용자가 취소했어요."),
    (re.compile(r"validation|invalid|검증 실패", re.I),
        "입력 값이 올바르지 않아요. 다시 확인해 주세요."),
]

_PUBLIC_ERROR_FALLBACK = "알 수 없는 이유로 실패했어요."


def _map_public_error(raw: Optional[str]) -> str:
    """Map a worker error string to a Korean user-facing message.

    Returns the fallback message for empty/None input or no pattern match.
    Never returns the raw string — that path could leak internals.
    """
    if not raw:
        return _PUBLIC_ERROR_FALLBACK
    for pattern, message in _ERROR_MAP:
        if pattern.search(raw):
            return message
    return _PUBLIC_ERROR_FALLBACK


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


async def persist_terminal_failure(
    *,
    user_id: str,
    task_id: str,
    type: str,                                 # "generate" | "conversation"
    status: str,                               # "error" | "cancelled"
    error: Optional[str],
    params: Optional[dict] = None,
    playlist_id: Optional[str] = None,
    started_at: Optional[datetime] = None,
    created_at: Optional[datetime] = None,
) -> None:
    """Write a studio_results row for a terminal failure or cancellation.

    Plan decision #20 (BLOCKING): without this, library status filters
    return empty grids because no rows exist for status in (error, cancelled).

    Wired into:
      - app.py exception handlers for generate_video_task + conversation_task
      - task_queue.cancel_task

    Guarantees `completed_at` is set so the latest-sort index serves these
    rows (decision #19 — no coalesce needed).

    Failures here are swallowed and logged: never let a manifest write
    derail the original error/cancel path.
    """
    if status not in ("error", "cancelled"):
        raise ValueError(
            f"persist_terminal_failure expects status in (error, cancelled), got {status!r}"
        )
    try:
        public_error = _map_public_error(error) if status == "error" else "사용자가 취소했어요."
        manifest = {
            "task_id": task_id,
            "type": type,
            "status": status,
            "error": error,                        # raw, admin-readable only
            "public_error": public_error,          # user-facing
            "params": params or {},
            "playlist_id": playlist_id,
            "created_at": created_at or _now(),
            "started_at": started_at,
            "completed_at": _now(),                # always set (decision #19)
            "video_path": None,
            "video_bytes": 0,
        }
        await upsert(user_id, manifest)
    except Exception as e:
        logger.warning(
            "persist_terminal_failure failed for task %s (user %s, status %s): %s",
            task_id, user_id, status, e,
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


_TERMINAL_STATUSES = ("completed", "error", "cancelled")


def _build_history_query(
    user_id: str,
    *,
    statuses: Optional[list[str]],
    playlist_id: Optional[str],
) -> dict[str, Any]:
    """Translate (statuses, playlist_id) into a Mongo query dict.

    Shared by list_for_user + counts_for_user so the filter logic stays
    in one place. `statuses=None` defaults to all 3 terminal states.
    """
    query: dict[str, Any] = {"user_id": user_id}
    if statuses is None:
        query["status"] = {"$in": list(_TERMINAL_STATUSES)}
    elif len(statuses) == 1:
        query["status"] = statuses[0]
    else:
        query["status"] = {"$in": list(statuses)}

    if playlist_id is not None:
        if playlist_id == "unassigned":
            query["playlist_id"] = None
        else:
            query["playlist_id"] = playlist_id
    return query


async def list_for_user(
    user_id: str,
    *,
    statuses: Optional[list[str]] = None,
    playlist_id: Optional[str] = None,
    offset: int = 0,
    limit: int = 24,
) -> tuple[list[dict], int]:
    """Return paginated terminal manifests for `user_id`, latest first.

    Plan decision #19: sort by `completed_at DESC, task_id ASC`. All terminal
    rows are guaranteed to have `completed_at` set (success path writes it on
    completion; error/cancel path writes it via `persist_terminal_failure`).
    Served by index {user_id:1, completed_at:-1}.

    Returns (rows, total_matching). `total_matching` ignores pagination so
    callers can compute page count.

    `statuses=None` → all terminal states (completed + error + cancelled).
    `playlist_id`:
        None         → no playlist filter
        "unassigned" → playlist_id is null
        <hex id>     → exact match (unknown id → empty, decision #12)
    """
    query = _build_history_query(user_id, statuses=statuses, playlist_id=playlist_id)
    coll = _coll()
    total = await coll.count_documents(query)
    cursor = (coll
              .find(query, projection={"_id": 0, "_imported_at": 0})
              .sort([("completed_at", -1), ("task_id", 1)])
              .skip(max(0, offset))
              .limit(max(1, min(100, limit))))
    rows = [d async for d in cursor]
    return rows, total


async def counts_for_user(
    user_id: str,
    *,
    playlist_id: Optional[str] = None,
) -> dict[str, int]:
    """Return {all, completed, error, cancelled} counts. Single aggregate.

    Plan decision #14: separate /api/history/counts endpoint, recomputed
    per request. Caching deferred — counts change with every task lifecycle
    event + playlist move and ETag invalidation isn't worth the wiring.
    """
    base_match = _build_history_query(user_id, statuses=None, playlist_id=playlist_id)
    pipeline = [
        {"$match": base_match},
        {"$group": {"_id": "$status", "count": {"$sum": 1}}},
    ]
    by_status: dict[str, int] = {}
    async for row in _coll().aggregate(pipeline):
        by_status[row["_id"]] = row["count"]
    completed = by_status.get("completed", 0)
    error = by_status.get("error", 0)
    cancelled = by_status.get("cancelled", 0)
    return {
        "all": completed + error + cancelled,
        "completed": completed,
        "error": error,
        "cancelled": cancelled,
    }


async def list_completed(
    user_id: str,
    *,
    limit: int = 50,
    playlist_id: Optional[str] = None,
) -> list[dict]:
    """Deprecated wrapper around list_for_user(statuses=["completed"]).

    Kept during the migration window so callers outside this PR don't break.
    Drops the `total` second tuple element. Remove after frontend cuts over.
    """
    rows, _total = await list_for_user(
        user_id,
        statuses=["completed"],
        playlist_id=playlist_id,
        offset=0,
        limit=limit,
    )
    return rows


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
