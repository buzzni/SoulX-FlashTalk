"""
Persistent Task Queue for SoulX-FlashTalk Video Generation

JSON 파일 기반으로 큐를 저장하여 서버 재시작 시에도 작업 이어서 처리 가능.
GPU 제한으로 한 번에 하나의 작업만 실행.
"""

import os
import json
import asyncio
import logging
from datetime import datetime
from typing import Optional, Callable, Awaitable

logger = logging.getLogger(__name__)

QUEUE_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "outputs", "task_queue.json")


class TaskQueue:
    def __init__(self):
        self._queue: list[dict] = []
        self._lock = asyncio.Lock()
        self._worker_task: Optional[asyncio.Task] = None
        self._event = asyncio.Event()  # signals when new work is available
        self._handlers: dict[str, Callable] = {}  # type -> async handler function
        self._load()

    # ── Persistence ──

    def _load(self):
        if os.path.exists(QUEUE_FILE):
            try:
                with open(QUEUE_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                raw = data.get("queue", [])
                # Plan decision #9: legacy entries (pre-PR2) lack `user_id`.
                # Skip them on load — they have no safe owner to assign and
                # the worker would otherwise treat them as anyone's job.
                self._queue = [e for e in raw if e.get("user_id")]
                dropped = len(raw) - len(self._queue)
                if dropped:
                    logger.warning(
                        f"Dropped {dropped} legacy queue entries lacking user_id "
                        f"(loaded {len(self._queue)} owner-tagged)"
                    )
                else:
                    logger.info(f"Loaded {len(self._queue)} tasks from queue file")
            except Exception as e:
                logger.error(f"Failed to load queue file: {e}")
                self._queue = []
        else:
            self._queue = []

    def _save(self):
        os.makedirs(os.path.dirname(QUEUE_FILE), exist_ok=True)
        try:
            with open(QUEUE_FILE, "w", encoding="utf-8") as f:
                json.dump({"queue": self._queue}, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error(f"Failed to save queue file: {e}")

    # ── Public API ──

    def register_handler(self, task_type: str, handler: Callable[..., Awaitable]):
        """Register an async handler for a task type."""
        self._handlers[task_type] = handler

    async def enqueue(self, task_id: str, task_type: str, params: dict, *,
                       user_id: str, label: str = "") -> dict:
        """Add a task to the queue. Returns the queue entry.

        `user_id` is required (PR2). It pins task ownership for queue/progress/cancel
        endpoints and survives serialization to task_queue.json.
        """
        if not user_id:
            raise ValueError("enqueue requires user_id (PR2 decision #9)")
        async with self._lock:
            entry = {
                "task_id": task_id,
                "user_id": user_id,
                "type": task_type,
                "params": params,
                "label": label,
                "status": "pending",
                "created_at": datetime.now().isoformat(),
                "started_at": None,
                "completed_at": None,
                "error": None,
            }
            self._queue.append(entry)
            self._save()
            logger.info(
                f"Enqueued task {task_id} ({task_type}) for user_id={user_id}, "
                f"queue size: {self._pending_count()}"
            )

        self._event.set()  # wake the worker
        return entry

    async def cancel_task(self, task_id: str, *, requesting_user_id: Optional[str] = None,
                           is_admin: bool = False) -> str:
        """Cancel a pending task. Returns:
            - "ok"          — cancelled
            - "not_found"   — no such task in pending state
            - "forbidden"   — task exists but belongs to another user
        """
        async with self._lock:
            for entry in self._queue:
                if entry["task_id"] != task_id:
                    continue
                if entry["status"] != "pending":
                    return "not_found"
                if (not is_admin and requesting_user_id is not None
                        and entry.get("user_id") != requesting_user_id):
                    return "forbidden"
                entry["status"] = "cancelled"
                entry["completed_at"] = datetime.now().isoformat()
                self._save()
                logger.info(f"Cancelled task {task_id} (by user={requesting_user_id})")
                return "ok"
        return "not_found"

    async def get_status(self, *, user_id: Optional[str] = None) -> dict:
        """Get queue status.

        If `user_id` is given, the snapshot is filtered to that user's tasks
        (per plan decision #9). Pass None for an admin / unfiltered view.
        """
        async with self._lock:
            def _own(e: dict) -> bool:
                return user_id is None or e.get("user_id") == user_id
            running = [e for e in self._queue if e["status"] == "running" and _own(e)]
            pending = [e for e in self._queue if e["status"] == "pending" and _own(e)]
            recent = [e for e in self._queue
                      if e["status"] in ("completed", "error", "cancelled") and _own(e)]
            # Keep only last 20 completed
            recent = sorted(recent, key=lambda x: x.get("completed_at") or "", reverse=True)[:20]

            return {
                "running": running,
                "pending": pending,
                "recent": recent,
                "total_pending": len(pending),
                "total_running": len(running),
            }

    async def get_task_owner(self, task_id: str) -> Optional[str]:
        """Return the user_id that owns task_id, or None if unknown."""
        async with self._lock:
            for entry in self._queue:
                if entry["task_id"] == task_id:
                    return entry.get("user_id")
        return None

    # ── Worker ──

    def _pending_count(self) -> int:
        return sum(1 for e in self._queue if e["status"] == "pending")

    async def _recover_interrupted(self):
        """On startup, reset any 'running' tasks back to 'pending'."""
        async with self._lock:
            recovered = 0
            for entry in self._queue:
                if entry["status"] == "running":
                    entry["status"] = "pending"
                    entry["started_at"] = None
                    recovered += 1
            if recovered:
                self._save()
                logger.info(f"Recovered {recovered} interrupted tasks back to pending")

    async def _get_next(self) -> Optional[dict]:
        """Get the next pending task (FIFO)."""
        async with self._lock:
            for entry in self._queue:
                if entry["status"] == "pending":
                    entry["status"] = "running"
                    entry["started_at"] = datetime.now().isoformat()
                    self._save()
                    return entry
        return None

    async def _mark_done(self, task_id: str, error: Optional[str] = None):
        """Mark a task as completed or errored."""
        async with self._lock:
            for entry in self._queue:
                if entry["task_id"] == task_id:
                    entry["status"] = "error" if error else "completed"
                    entry["completed_at"] = datetime.now().isoformat()
                    entry["error"] = error
                    break
            # Prune: keep at most 50 finished tasks
            finished = [e for e in self._queue if e["status"] in ("completed", "error", "cancelled")]
            if len(finished) > 50:
                oldest = sorted(finished, key=lambda x: x.get("completed_at") or "")
                to_remove = set(e["task_id"] for e in oldest[: len(finished) - 50])
                self._queue = [e for e in self._queue if e["task_id"] not in to_remove]
            self._save()

    async def _worker_loop(self):
        """Main worker: process one task at a time."""
        logger.info("Queue worker started")
        while True:
            # Wait for work
            self._event.clear()
            entry = await self._get_next()

            if entry is None:
                await self._event.wait()
                continue

            task_id = entry["task_id"]
            task_type = entry["type"]
            handler = self._handlers.get(task_type)

            if not handler:
                logger.error(f"No handler for task type: {task_type}")
                await self._mark_done(task_id, error=f"Unknown task type: {task_type}")
                continue

            logger.info(f"Processing task {task_id} ({task_type})")
            try:
                # PR2: pass owner through to the handler so downstream code
                # (lifecycle commit, manifest write) can scope by user_id.
                await handler(
                    task_id=task_id,
                    user_id=entry.get("user_id"),
                    **entry["params"],
                )
                await self._mark_done(task_id)
            except Exception as e:
                logger.error(f"Task {task_id} failed in worker: {e}")
                await self._mark_done(task_id, error=str(e))

    async def start(self):
        """Start the queue worker. Call during app startup."""
        await self._recover_interrupted()
        self._worker_task = asyncio.create_task(self._worker_loop())
        # Kick the worker in case there are pending tasks from recovery
        if self._pending_count() > 0:
            self._event.set()

    async def stop(self):
        """Stop the queue worker."""
        if self._worker_task:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass


# Singleton
task_queue = TaskQueue()
