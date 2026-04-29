"""
Persistent Task Queue for SoulX-FlashTalk Video Generation.

Persists to Mongo `generation_jobs` collection (PR-5: was a JSON file
under outputs/, which leaked LocalDisk dependence + state-on-host
assumptions). Backend restart re-reads the collection so `pending` /
`running` tasks survive a process restart, and `running` rows are
recovered to `pending` on startup so the worker re-picks them up.

GPU constraint: one task at a time. The dispatch loop is a single
asyncio task that pulls pending rows FIFO via `find_one_and_update`.
"""

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional, Callable, Awaitable

logger = logging.getLogger(__name__)

DEFAULT_COLLECTION = "generation_jobs"

# Cap finished entries; oldest beyond this are pruned on every _mark_done.
MAX_FINISHED = 50


class TaskQueue:
    """Mongo-backed task queue.

    `collection_name` lets tests run against an isolated collection
    without touching the production `generation_jobs` rows.
    """

    def __init__(self, collection_name: str = DEFAULT_COLLECTION):
        self._collection_name = collection_name
        self._lock = asyncio.Lock()
        self._worker_task: Optional[asyncio.Task] = None
        self._event = asyncio.Event()  # signals when new work is available
        self._handlers: dict[str, Callable] = {}  # type -> async handler function

    # ── Persistence ──

    def _coll(self):
        """Fetch the Mongo collection lazily so __init__ can run before
        db_module.init() (the singleton is created at module import)."""
        from modules import db as db_module
        return db_module.get_db()[self._collection_name]

    async def _ensure_indexes(self) -> None:
        """Idempotent — safe on every startup."""
        coll = self._coll()
        try:
            await coll.create_index("task_id", unique=True)
            await coll.create_index([("user_id", 1), ("status", 1)])
            await coll.create_index([("status", 1), ("created_at", 1)])
            await coll.create_index([("completed_at", -1)])
        except Exception as e:
            # Don't block startup on index issues — collection still works.
            logger.warning("generation_jobs index creation failed: %s", e)

    async def _recover_interrupted(self) -> None:
        """Reset any 'running' rows back to 'pending' (process restarted
        mid-task). FIFO ordering is preserved via the original
        `created_at` so a recovered task is re-picked in turn."""
        coll = self._coll()
        result = await coll.update_many(
            {"status": "running"},
            {"$set": {"status": "pending", "started_at": None}},
        )
        if result.modified_count:
            logger.info(
                "Recovered %d interrupted tasks back to pending",
                result.modified_count,
            )

    @staticmethod
    def _strip_id(entry: dict) -> dict:
        entry.pop("_id", None)
        return entry

    # ── Public API ──

    def register_handler(self, task_type: str, handler: Callable[..., Awaitable]):
        """Register an async handler for a task type."""
        self._handlers[task_type] = handler

    async def enqueue(self, task_id: str, task_type: str, params: dict, *,
                       user_id: str, label: str = "") -> dict:
        """Add a task to the queue. Returns the persisted entry.

        `user_id` is required. Pins task ownership for queue/progress/cancel
        endpoints and survives the Mongo round-trip.
        """
        if not user_id:
            raise ValueError("enqueue requires user_id (PR2 decision #9)")
        entry = {
            "task_id": task_id,
            "user_id": user_id,
            "type": task_type,
            "params": params,
            "label": label,
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "started_at": None,
            "completed_at": None,
            "error": None,
            "retried_from": None,
        }
        await self._coll().insert_one(entry)
        logger.info(
            "Enqueued task %s (%s) for user_id=%s",
            task_id, task_type, user_id,
        )
        self._event.set()
        return self._strip_id(entry)

    async def cancel_task(self, task_id: str, *, requesting_user_id: Optional[str] = None,
                           is_admin: bool = False) -> str:
        """Cancel a pending task. Returns:
            - "ok"        — cancelled
            - "not_found" — no such task or not pending anymore
            - "forbidden" — task exists but belongs to another user
        """
        coll = self._coll()
        entry = await coll.find_one({"task_id": task_id})
        if entry is None or entry.get("status") != "pending":
            return "not_found"
        if (not is_admin and requesting_user_id is not None
                and entry.get("user_id") != requesting_user_id):
            return "forbidden"

        completed_at = datetime.now(timezone.utc).isoformat()
        await coll.update_one(
            {"task_id": task_id, "status": "pending"},
            {"$set": {"status": "cancelled", "completed_at": completed_at}},
        )
        logger.info("Cancelled task %s (by user=%s)", task_id, requesting_user_id)

        # Decision #20: cancellation must produce a studio_results row so
        # /results status=cancelled has data to show. Failure on this side
        # is logged-and-swallowed so the user-facing cancel still succeeds.
        if entry.get("user_id"):
            try:
                from modules.repositories import studio_result_repo as _result_repo
                created_at = None
                if entry.get("created_at"):
                    try:
                        created_at = datetime.fromisoformat(entry["created_at"])
                        if created_at.tzinfo is None:
                            created_at = created_at.replace(tzinfo=timezone.utc)
                    except ValueError:
                        created_at = None
                await _result_repo.persist_terminal_failure(
                    user_id=entry["user_id"],
                    task_id=task_id,
                    type=entry.get("type", "generate"),
                    status="cancelled",
                    error=None,
                    params=entry.get("params") or {},
                    playlist_id=(entry.get("params") or {}).get("playlist_id"),
                    started_at=None,
                    created_at=created_at,
                    retried_from=entry.get("retried_from"),
                )
            except Exception as e:
                logger.warning(
                    "cancel_task %s: terminal-failure persist failed: %s", task_id, e,
                )
        return "ok"

    async def retry_task(self, task_id: str, *, requesting_user_id: Optional[str] = None,
                          is_admin: bool = False) -> tuple[Optional[str], str]:
        """Re-enqueue a finished (error/cancelled) task with the same params
        under a fresh task_id. Returns (new_task_id, "ok") on success;
        (None, reason) where reason is "not_found" / "forbidden" / "not_finished".
        Owner-only unless is_admin. The original entry is untouched so users
        can still see what failed and what replaced it side by side.

        Lineage: the new entry carries `retried_from` pointing back at the
        original task_id (eng-review 1A — D3A retry-aware primary).
        """
        coll = self._coll()
        entry = await coll.find_one({"task_id": task_id})
        if entry is None:
            return None, "not_found"
        if (not is_admin and requesting_user_id is not None
                and entry.get("user_id") != requesting_user_id):
            # Don't leak existence: caller maps to 404
            return None, "forbidden"
        if entry.get("status") not in ("error", "cancelled"):
            return None, "not_finished"

        new_task_id = uuid.uuid4().hex
        new_entry = {
            "task_id": new_task_id,
            "user_id": entry["user_id"],
            "type": entry["type"],
            "params": dict(entry["params"]),
            "label": entry.get("label", ""),
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "started_at": None,
            "completed_at": None,
            "error": None,
            "retried_from": task_id,
        }
        await coll.insert_one(new_entry)
        logger.info(
            "Retried task %s as %s (by user=%s)",
            task_id, new_task_id, requesting_user_id,
        )
        self._event.set()
        return new_task_id, "ok"

    async def get_status(self, *, user_id: Optional[str] = None) -> dict:
        """Get queue snapshot.

        If `user_id` is given, the snapshot is filtered to that user's tasks
        (per plan decision #9). Pass None for an admin / unfiltered view.
        """
        coll = self._coll()
        flt: dict = {}
        if user_id is not None:
            flt["user_id"] = user_id

        running = [self._strip_id(e) async for e in coll.find(
            {**flt, "status": "running"},
        ).sort("started_at", 1)]
        pending = [self._strip_id(e) async for e in coll.find(
            {**flt, "status": "pending"},
        ).sort("created_at", 1)]
        recent = [self._strip_id(e) async for e in coll.find(
            {**flt, "status": {"$in": ["completed", "error", "cancelled"]}},
        ).sort("completed_at", -1).limit(20)]

        return {
            "running": running,
            "pending": pending,
            "recent": recent,
            "total_pending": len(pending),
            "total_running": len(running),
        }

    async def get_task_owner(self, task_id: str) -> Optional[str]:
        """Return the user_id that owns task_id, or None if unknown."""
        entry = await self._coll().find_one({"task_id": task_id})
        return entry.get("user_id") if entry else None

    # ── Worker ──

    async def _get_next(self) -> Optional[dict]:
        """Atomically pull the next pending task and mark it running.

        FIFO via `created_at` index. `find_one_and_update` is the Mongo
        atomic primitive; no outer lock is needed because the worker is
        single-threaded by design (one GPU task at a time).
        """
        result = await self._coll().find_one_and_update(
            {"status": "pending"},
            {"$set": {
                "status": "running",
                "started_at": datetime.now(timezone.utc).isoformat(),
            }},
            sort=[("created_at", 1)],
            return_document=False,  # default: returns pre-update doc
        )
        if result is None:
            return None
        # Reflect the local mutation since we asked for pre-update doc.
        result["status"] = "running"
        return self._strip_id(result)

    async def _mark_done(self, task_id: str, error: Optional[str] = None) -> None:
        """Mark a task as completed or errored. Prune oldest beyond
        MAX_FINISHED to keep the collection bounded."""
        coll = self._coll()
        await coll.update_one(
            {"task_id": task_id},
            {"$set": {
                "status": "error" if error else "completed",
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "error": error,
            }},
        )
        # Prune
        finished_count = await coll.count_documents(
            {"status": {"$in": ["completed", "error", "cancelled"]}}
        )
        if finished_count > MAX_FINISHED:
            cursor = coll.find(
                {"status": {"$in": ["completed", "error", "cancelled"]}},
            ).sort("completed_at", 1).limit(finished_count - MAX_FINISHED)
            old_ids = [e["task_id"] async for e in cursor]
            if old_ids:
                await coll.delete_many({"task_id": {"$in": old_ids}})

    async def _worker_loop(self) -> None:
        """Main worker: process one task at a time."""
        logger.info("Queue worker started")
        while True:
            self._event.clear()
            entry = await self._get_next()

            if entry is None:
                await self._event.wait()
                continue

            task_id = entry["task_id"]
            task_type = entry["type"]
            handler = self._handlers.get(task_type)

            if not handler:
                logger.error("No handler for task type: %s", task_type)
                await self._mark_done(task_id, error=f"Unknown task type: {task_type}")
                continue

            logger.info("Processing task %s (%s)", task_id, task_type)
            try:
                handler_kwargs = dict(entry["params"])
                if entry.get("retried_from") is not None:
                    handler_kwargs["retried_from"] = entry["retried_from"]
                await handler(
                    task_id=task_id,
                    user_id=entry.get("user_id"),
                    **handler_kwargs,
                )
                await self._mark_done(task_id)
            except Exception as e:
                logger.error("Task %s failed in worker: %s", task_id, e)
                await self._mark_done(task_id, error=str(e))

    async def start(self) -> None:
        """Start the queue worker. Call during app startup."""
        await self._ensure_indexes()
        await self._recover_interrupted()
        self._worker_task = asyncio.create_task(self._worker_loop())
        # Kick the worker if there are pending tasks from recovery.
        pending = await self._coll().count_documents({"status": "pending"})
        if pending > 0:
            self._event.set()

    async def stop(self) -> None:
        """Stop the queue worker."""
        if self._worker_task:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass


# Singleton
task_queue = TaskQueue()
