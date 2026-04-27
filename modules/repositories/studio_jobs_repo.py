"""generation_jobs collection — first-class server-side generation entity.

Backs the streaming-resume feature (docs/plans/streaming-resume-eng-spec.md).
Frontend treats generation as `attached(jobId)` and pulls state from the
server, so reload, cross-device, and history all flow through this row.

State machine (eng-spec §5):

    create()
      └─→ state='pending'
    mark_streaming()
      └─→ state='streaming', heartbeat_at set
    append_variant()                            (only when state='streaming')
      └─→ variants[] grows; updated_at bumps
    mark_ready()                                (only when state='streaming')
      └─→ state='ready', batch_id + prev_selected_image_id set
    mark_failed()                               (pending|streaming)
      └─→ state='failed', error set
    mark_cancelled()                            (pending|streaming, owner-scoped)
      └─→ state='cancelled'
    update_heartbeat()                          (only when state='streaming')
      └─→ heartbeat_at bumped

Conditional state guards return False on a state mismatch so callers can
detect a concurrent cancel and break their work loop (eng-spec §4
cancel-vs-append atomicity).

Dedupe-by-reuse: a partial unique index on (user_id, input_hash) where
state ∈ {pending, streaming} collapses concurrent re-rolls of the same
input onto a single row. create() catches DuplicateKeyError and returns
the active row (eng-spec §6.5).

Every method is owner-scoped where ownership is meaningful (eng-spec §8).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from modules import db as db_module

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants — exported so API/runner layers don't string-spell states.
# ---------------------------------------------------------------------------

KINDS: tuple[str, ...] = ("host", "composite")
ACTIVE_STATES: tuple[str, ...] = ("pending", "streaming")
TERMINAL_STATES: tuple[str, ...] = ("ready", "failed", "cancelled")
ALL_STATES: tuple[str, ...] = ACTIVE_STATES + TERMINAL_STATES


# ---------------------------------------------------------------------------
# Internal
# ---------------------------------------------------------------------------

def _coll():
    return db_module.get_db().generation_jobs


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _serialize(doc: Optional[dict]) -> Optional[dict]:
    """Public API shape — input_blob is server-internal and intentionally omitted
    (eng-spec §8: only POST handler reads it back via get_by_id_internal)."""
    if doc is None:
        return None
    return {
        "id": doc["_id"],
        "user_id": doc["user_id"],
        "kind": doc["kind"],
        "state": doc["state"],
        "variants": list(doc.get("variants") or []),
        "prev_selected_image_id": doc.get("prev_selected_image_id"),
        "batch_id": doc.get("batch_id"),
        "error": doc.get("error"),
        "input_hash": doc.get("input_hash"),
        "created_at": doc.get("created_at"),
        "updated_at": doc.get("updated_at"),
        "heartbeat_at": doc.get("heartbeat_at"),
    }


# ---------------------------------------------------------------------------
# Public API — create / read
# ---------------------------------------------------------------------------

async def create(
    *,
    user_id: str,
    kind: str,
    input_hash: str,
    input_blob: dict,
) -> dict:
    """Insert a new pending job. Dedupe-by-reuse on (user_id, input_hash):
    if an active row already exists, that row is returned instead.

    Raises:
      ValueError on bad kind.
    """
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}, got {kind!r}")

    job_id = str(uuid.uuid4())
    now = _now()
    doc = {
        "_id": job_id,
        "user_id": user_id,
        "kind": kind,
        "state": "pending",
        "input_hash": input_hash,
        "input_blob": input_blob,
        "variants": [],
        "prev_selected_image_id": None,
        "batch_id": None,
        "error": None,
        "created_at": now,
        "updated_at": now,
        "heartbeat_at": None,
    }
    try:
        await _coll().insert_one(doc)
    except DuplicateKeyError:
        # Active job for the same (user_id, input_hash) already exists —
        # return it rather than creating a duplicate. The partial unique
        # index drops out for terminal rows, so a re-roll after a previous
        # ready/failed/cancelled inserts cleanly.
        existing = await find_active_by_hash(user_id, input_hash)
        if existing is None:
            # Race: the conflicting row terminated between our insert and our
            # read. Retry once with a fresh uuid; if it conflicts again, give
            # up — the dedupe semantic is best-effort and surfacing the error
            # is better than looping.
            doc["_id"] = str(uuid.uuid4())
            await _coll().insert_one(doc)
            return _serialize(doc)
        # find_active_by_hash already returns the serialized shape.
        return existing
    return _serialize(doc)


async def get_by_id(user_id: str, job_id: str) -> Optional[dict]:
    """Owner-scoped fetch. None if not found OR owned by a different user
    (callers map both to 404 — eng-spec §8 — to avoid id-existence leaks)."""
    doc = await _coll().find_one({"_id": job_id, "user_id": user_id})
    return _serialize(doc)


async def get_by_id_internal(job_id: str) -> Optional[dict]:
    """Worker-side fetch (no ownership scoping; the worker already knows the
    job_id from its own queue)."""
    doc = await _coll().find_one({"_id": job_id})
    return _serialize(doc)


async def get_input_blob(job_id: str) -> Optional[dict]:
    """Worker reads the original input to drive the model. Kept private so
    the public _serialize() never leaks input_blob to the API."""
    doc = await _coll().find_one(
        {"_id": job_id}, projection={"input_blob": 1}
    )
    if doc is None:
        return None
    return doc.get("input_blob")


async def find_active_by_hash(user_id: str, input_hash: str) -> Optional[dict]:
    """Lookup of the dedupe slot — the row that the partial unique index
    constrains. Used by create()'s race-recovery path."""
    doc = await _coll().find_one({
        "user_id": user_id,
        "input_hash": input_hash,
        "state": {"$in": list(ACTIVE_STATES)},
    })
    return _serialize(doc)


async def list_by_user(
    user_id: str,
    *,
    kind: Optional[str] = None,
    state: Optional[str] = None,
    limit: int = 20,
    cursor: Optional[str] = None,
) -> dict:
    """Cursor-paginated list. Sort: created_at desc, _id desc (stable on
    same-microsecond ties). cursor is the last item's job_id.

    Returns {"items": [<serialized>], "next_cursor": <job_id> | None}.
    """
    if limit < 1:
        limit = 1
    if limit > 50:
        limit = 50

    query: dict[str, Any] = {"user_id": user_id}
    if kind is not None:
        if kind not in KINDS:
            raise ValueError(f"kind must be one of {KINDS}, got {kind!r}")
        query["kind"] = kind
    if state is not None:
        if state not in ALL_STATES:
            raise ValueError(f"state must be one of {ALL_STATES}, got {state!r}")
        query["state"] = state

    if cursor is not None:
        cursor_doc = await _coll().find_one(
            {"_id": cursor, "user_id": user_id},
            projection={"created_at": 1},
        )
        if cursor_doc is not None:
            cursor_ts = cursor_doc["created_at"]
            query["$or"] = [
                {"created_at": {"$lt": cursor_ts}},
                {"created_at": cursor_ts, "_id": {"$lt": cursor}},
            ]
        # If cursor_doc is None, the client passed a stale cursor — return
        # the head of the list rather than 400ing. Frontend treats a cursor
        # miss as "list reset".

    items: list[dict] = []
    found = _coll().find(query).sort([("created_at", -1), ("_id", -1)]).limit(limit + 1)
    async for raw in found:
        items.append(raw)

    has_more = len(items) > limit
    if has_more:
        items = items[:limit]
    next_cursor = items[-1]["_id"] if has_more and items else None

    return {
        "items": [_serialize(d) for d in items],
        "next_cursor": next_cursor,
    }


# ---------------------------------------------------------------------------
# Public API — state transitions (conditional updates).
#
# Every transition uses find_one_and_update with a state-aware filter so a
# concurrent cancel collapses cleanly: the second writer's filter matches 0
# rows, returns None, and the caller breaks its loop. This is the eng-spec
# §4 cancel-vs-append guarantee at the data layer.
# ---------------------------------------------------------------------------

async def mark_streaming(job_id: str) -> bool:
    """pending → streaming. Sets heartbeat_at. Returns True on transition,
    False if the job was cancelled (or already terminal) before the worker
    picked it up."""
    now = _now()
    updated = await _coll().find_one_and_update(
        {"_id": job_id, "state": "pending"},
        {"$set": {
            "state": "streaming",
            "heartbeat_at": now,
            "updated_at": now,
        }},
        return_document=ReturnDocument.AFTER,
    )
    return updated is not None


async def append_variant(job_id: str, variant: dict) -> bool:
    """Atomically append to variants[] AND refresh heartbeat, only if state
    is still 'streaming'. False on state mismatch — caller MUST break its
    loop and unlink any just-saved file (eng-spec §4)."""
    now = _now()
    updated = await _coll().find_one_and_update(
        {"_id": job_id, "state": "streaming"},
        {
            "$push": {"variants": variant},
            "$set": {"heartbeat_at": now, "updated_at": now},
        },
        return_document=ReturnDocument.AFTER,
    )
    return updated is not None


async def mark_ready(
    job_id: str,
    *,
    batch_id: str,
    prev_selected_image_id: Optional[str] = None,
) -> bool:
    """streaming → ready. False if the job was cancelled mid-stream — caller
    has already cleaned up files via append_variant returning False, so the
    final mark_ready dropping out is the expected race outcome."""
    now = _now()
    updated = await _coll().find_one_and_update(
        {"_id": job_id, "state": "streaming"},
        {"$set": {
            "state": "ready",
            "batch_id": batch_id,
            "prev_selected_image_id": prev_selected_image_id,
            "updated_at": now,
        }},
        return_document=ReturnDocument.AFTER,
    )
    return updated is not None


async def mark_failed(job_id: str, error: str) -> bool:
    """{pending|streaming} → failed. False if the job was cancelled
    (cancelled wins over failed since the user's intent was explicit)."""
    now = _now()
    updated = await _coll().find_one_and_update(
        {"_id": job_id, "state": {"$in": list(ACTIVE_STATES)}},
        {"$set": {
            "state": "failed",
            "error": error,
            "updated_at": now,
        }},
        return_document=ReturnDocument.AFTER,
    )
    return updated is not None


async def mark_cancelled(job_id: str, *, owner_user_id: str) -> bool:
    """{pending|streaming} → cancelled, scoped to the owner. False if
    already terminal — DELETE handler maps to 409 (eng-spec §8).

    The conditional state filter guarantees that an in-flight worker writing
    a variant via append_variant() loses the race exactly once and breaks."""
    now = _now()
    updated = await _coll().find_one_and_update(
        {
            "_id": job_id,
            "user_id": owner_user_id,
            "state": {"$in": list(ACTIVE_STATES)},
        },
        {"$set": {
            "state": "cancelled",
            "updated_at": now,
        }},
        return_document=ReturnDocument.AFTER,
    )
    return updated is not None


async def update_heartbeat(job_id: str) -> bool:
    """Worker-only. False if the job slipped out of streaming — caller
    should treat as a cancel signal and break."""
    now = _now()
    updated = await _coll().find_one_and_update(
        {"_id": job_id, "state": "streaming"},
        {"$set": {"heartbeat_at": now, "updated_at": now}},
        return_document=ReturnDocument.AFTER,
    )
    return updated is not None


# ---------------------------------------------------------------------------
# Public API — bulk recovery (JobRunner-owned).
# ---------------------------------------------------------------------------

async def mark_active_as_failed(error: str) -> int:
    """Bulk transition pending+streaming → failed. Used by JobRunner.start()
    to reap orphaned rows: the in-process submit registry is lost on restart,
    so any active row left over from a prior process can never make progress.

    Returns the number of rows transitioned."""
    now = _now()
    res = await _coll().update_many(
        {"state": {"$in": list(ACTIVE_STATES)}},
        {"$set": {"state": "failed", "error": error, "updated_at": now}},
    )
    return int(res.modified_count)


async def mark_heartbeat_stale_as_failed(
    cutoff: datetime,
    *,
    error: str = "worker timeout (no heartbeat)",
) -> int:
    """Bulk transition: streaming rows whose heartbeat_at predates cutoff →
    failed. Used by the periodic sweep to catch silent stalls (disk full,
    GPU hang) where the worker stops emitting events but the task never
    raises.

    The partial index `state_heartbeat_streaming` covers this query. A
    streaming row with heartbeat_at=None is also considered stale (the
    worker never even bumped its first heartbeat) — match `$lt cutoff`
    OR `$exists False` to cover both shapes.

    Returns the number of rows transitioned."""
    now = _now()
    res = await _coll().update_many(
        {
            "state": "streaming",
            "$or": [
                {"heartbeat_at": {"$lt": cutoff}},
                {"heartbeat_at": None},
            ],
        },
        {"$set": {"state": "failed", "error": error, "updated_at": now}},
    )
    return int(res.modified_count)
