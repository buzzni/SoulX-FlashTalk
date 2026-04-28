"""Single-process orchestrator for generation_jobs.

Phase A step 2 of streaming-resume (eng-spec §2). Owns the worker side of
the GenerationJob lifecycle: pulls input_blob from the repo, drives the
registered handler async generator, applies events to the row, and pumps
them through a publisher (no-op until JobsPubSub lands in step 6).

Mirrors `modules.task_queue.TaskQueue` ownership:
- a strong-ref `_running` map prevents GC of fire-and-forget asyncio tasks
- start() runs recovery + spawns the heartbeat sweep
- stop() cancels the sweep + every in-flight job before the DB closes

Eng-spec §2.4 — single-process only. The pubsub is in-process asyncio,
so `WEB_CONCURRENCY > 1` cannot work without Redis (deferred to v2.1).
The fail-fast assertion lives in `assert_single_process_or_raise()`
below; app.py calls it as the first line of the startup hook so a
misconfigured deploy aborts before any DB connections are opened.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator, Awaitable, Callable, Optional

from modules.repositories import studio_jobs_repo as jobs_repo

logger = logging.getLogger(__name__)


# Handler contract (eng-spec §2.2). A handler is an async generator factory
# that yields event dicts. The runner translates events into repo writes.
#
# Event shapes:
#   {"type": "candidate", "variant": <dict>}
#   {"type": "done", "batch_id": <str>, "prev_selected_image_id": <str|None>}
#   {"type": "fatal", "error": <str>}
#
# The handler may raise — the runner catches and marks the job failed.
HandlerFactory = Callable[[str, dict], AsyncIterator[dict]]

# Publisher contract — step 6 (JobsPubSub) will provide the real impl.
Publisher = Callable[[str, dict], Awaitable[None]]


async def _noop_publish(job_id: str, event: dict) -> None:
    return None


def assert_single_process_or_raise() -> None:
    """Refuse to boot under multi-worker (eng-spec §2.4).

    JobRunner relies on in-process state — `_running` task map, per-job
    seq counters, and an asyncio.Queue per SSE subscriber. Each worker
    in a multi-worker setup has its OWN copy of these, so an event
    published by the worker that handled POST /api/jobs never reaches
    the worker that's serving GET /api/jobs/:id/events. The user sees
    a forever-pending stream.

    v2.1 will swap pubsub for Redis so multi-worker becomes safe. Until
    then, the fail-fast guard converts a silent UX bug into a loud
    deploy failure.

    Reads WEB_CONCURRENCY (gunicorn convention; uvicorn honors it when
    launched as a gunicorn worker). Unset or "1" → OK. Anything else
    → RuntimeError. Malformed values also raise — better to surface a
    config error than to fall through to a permissive default.
    """
    raw = os.environ.get("WEB_CONCURRENCY", "1")
    try:
        n = int(raw)
    except ValueError:
        raise RuntimeError(
            f"WEB_CONCURRENCY must be an integer, got {raw!r}"
        )
    if n > 1:
        raise RuntimeError(
            f"GenerationJobs requires single-process "
            f"(WEB_CONCURRENCY=1, got {n}). The in-process pubsub does "
            f"not span workers; v2.1 will introduce Redis-backed pubsub "
            f"for multi-worker scaling."
        )


class JobRunner:
    """Owns the worker side of the GenerationJob lifecycle.

    One instance per process. Handlers are registered per kind once at
    startup; submit(job_id) is fire-and-forget but tracked so shutdown
    can cancel cleanly.
    """

    # eng-spec §2.2 — sweep cadence + heartbeat freshness threshold.
    HEARTBEAT_TIMEOUT = timedelta(minutes=5)
    SWEEP_INTERVAL_S = 60

    def __init__(
        self,
        *,
        publisher: Optional[Publisher] = None,
        heartbeat_timeout: Optional[timedelta] = None,
        sweep_interval_s: Optional[float] = None,
    ) -> None:
        self._running: dict[str, asyncio.Task] = {}
        self._handlers: dict[str, HandlerFactory] = {}
        self._sweep_task: Optional[asyncio.Task] = None
        self._stopping = False
        self._started = False
        self._publish: Publisher = publisher or _noop_publish
        if heartbeat_timeout is not None:
            self.HEARTBEAT_TIMEOUT = heartbeat_timeout
        if sweep_interval_s is not None:
            self.SWEEP_INTERVAL_S = sweep_interval_s

    # ── Registration ──────────────────────────────────────────────────

    def register_handler(self, kind: str, factory: HandlerFactory) -> None:
        """Bind an event-stream factory to a job kind. Steps 3 (host) and 4
        (composite) wire real generators here."""
        if kind not in jobs_repo.KINDS:
            raise ValueError(
                f"kind must be one of {jobs_repo.KINDS}, got {kind!r}"
            )
        self._handlers[kind] = factory

    def set_publisher(self, publisher: Publisher) -> None:
        """Step 6 swaps the no-op publisher for JobsPubSub at runtime."""
        self._publish = publisher

    # ── Lifecycle ─────────────────────────────────────────────────────

    async def start(self) -> None:
        if self._started:
            return
        await self._recover_interrupted()
        self._sweep_task = asyncio.create_task(self._sweep_loop())
        self._started = True
        logger.info("JobRunner started (handlers=%s)", sorted(self._handlers))

    async def stop(self) -> None:
        """Cancel the sweep + every in-flight job, then mark each failed.
        Runs BEFORE db_module.close() so the final mark_failed write lands."""
        self._stopping = True
        if self._sweep_task is not None:
            self._sweep_task.cancel()
            try:
                await self._sweep_task
            except (asyncio.CancelledError, Exception):
                pass
            self._sweep_task = None

        for job_id, task in list(self._running.items()):
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
            # _run_one's CancelledError handler should have already written
            # mark_failed, but call it again defensively in case the cancel
            # raced before the except block ran. mark_failed is conditional
            # on {pending,streaming} so it's a no-op if state already moved.
            await jobs_repo.mark_failed(job_id, "server shutdown")
        self._running.clear()
        self._started = False
        logger.info("JobRunner stopped")

    # ── Submit ────────────────────────────────────────────────────────

    async def submit(self, job_id: str) -> None:
        """Fire-and-forget. Idempotent if job_id is already running.

        Raises:
            RuntimeError if the runner is stopping (caller should 503).
        """
        if self._stopping:
            raise RuntimeError("runner is stopping; cannot submit new jobs")
        if job_id in self._running:
            return
        task = asyncio.create_task(self._run_one(job_id))
        # Strong-ref retention — eng-spec §2.1 (asyncio.create_task losing
        # its only reference triggers GC mid-run).
        self._running[job_id] = task
        task.add_done_callback(
            lambda _t, jid=job_id: self._running.pop(jid, None)
        )

    # ── Internals ─────────────────────────────────────────────────────

    async def _run_one(self, job_id: str) -> None:
        """Drive one job's handler to terminal state.

        State machine:
            pending  → mark_streaming → handler events:
                       - candidate  → append_variant; break on False (cancel)
                       - done       → mark_ready and exit
                       - fatal      → mark_failed and exit
            handler exhausts without done/fatal → mark_failed
            handler raises                     → mark_failed
            asyncio.CancelledError             → mark_failed and re-raise

        Cancel semantics: a user DELETE flips state via mark_cancelled. The
        next conditional update (append_variant / mark_ready) returns False
        and we break — eng-spec §4 cancel-vs-append atomicity.
        """
        job = await jobs_repo.get_by_id_internal(job_id)
        if job is None:
            logger.warning("submit(%s): row vanished before run", job_id)
            return

        kind = job["kind"]
        handler = self._handlers.get(kind)
        if handler is None:
            await jobs_repo.mark_failed(
                job_id, error=f"no handler registered for kind={kind!r}"
            )
            return

        blob = await jobs_repo.get_input_blob(job_id)
        if blob is None:
            await jobs_repo.mark_failed(job_id, error="input_blob missing")
            return

        if not await jobs_repo.mark_streaming(job_id):
            # Cancelled before the worker picked it up. mark_streaming's
            # conditional filter returned 0 rows.
            return

        gen = handler(job_id, blob)
        try:
            async for evt in gen:
                if not await self._apply_event(job_id, evt):
                    return
            # Handler exhausted without yielding done/fatal — treat as a
            # protocol violation and fail loudly.
            if await jobs_repo.mark_failed(
                job_id, error="handler exited without done/fatal"
            ):
                await self._safe_publish(job_id, {
                    "type": "fatal",
                    "error": "handler exited without done/fatal",
                })
        except asyncio.CancelledError:
            # Server shutdown. mark_failed is conditional, so a cancel that
            # already won the race (state=cancelled) is a clean no-op here.
            await jobs_repo.mark_failed(job_id, error="cancelled by server")
            raise
        except Exception as e:  # noqa: BLE001 — handler errors must not kill the runner
            logger.exception("job %s handler raised", job_id)
            if await jobs_repo.mark_failed(
                job_id, error=f"handler error: {e}"
            ):
                await self._safe_publish(job_id, {
                    "type": "fatal",
                    "error": f"handler error: {e}",
                })
        finally:
            # aclose runs the handler's `finally` blocks so it can unlink
            # any just-saved file (eng-spec §4). aclose is a no-op if the
            # generator already terminated.
            try:
                await gen.aclose()
            except Exception:
                logger.exception(
                    "job %s handler aclose raised (non-fatal)", job_id
                )

    async def _apply_event(self, job_id: str, evt: dict) -> bool:
        """Translate one handler event into repo + publish. Returns False if
        the loop should stop (cancel detected, terminal event, unknown event
        with mark_failed)."""
        etype = evt.get("type")
        if etype == "candidate":
            ok = await jobs_repo.append_variant(
                job_id, evt.get("variant", {})
            )
            if not ok:
                # Cancelled mid-stream — handler's aclose() in `finally`
                # will run any cleanup it registered.
                return False
            await self._safe_publish(job_id, evt)
            return True
        if etype == "done":
            # Production path: lifecycle-aware ready transition. Reads
            # variants, records the batch + runs cleanup in studio_hosts,
            # then atomically flips state→ready (eng-spec §5). The handler
            # may pass batch_id in the event; if absent, the repo defaults
            # to job_id so each distinct job has a stable batch handle.
            job = await jobs_repo.get_by_id_internal(job_id)
            if job is None:
                return False
            ok = await jobs_repo.mark_ready_with_lifecycle(
                job_id,
                user_id=job["user_id"],
                kind=job["kind"],
                batch_id=evt.get("batch_id"),
            )
            if ok:
                await self._safe_publish(job_id, evt)
            return False  # terminal
        if etype == "fatal":
            ok = await jobs_repo.mark_failed(
                job_id, error=str(evt.get("error", "unknown error"))
            )
            if ok:
                await self._safe_publish(job_id, evt)
            return False  # terminal
        logger.warning(
            "job %s: ignoring unknown event type=%r", job_id, etype
        )
        return True

    async def _safe_publish(self, job_id: str, event: dict) -> None:
        """Publishing is best-effort: a broken pubsub must never poison the
        run loop. The DB row stays authoritative; SSE clients can resync via
        the snapshot endpoint."""
        try:
            await self._publish(job_id, event)
        except Exception:
            logger.exception(
                "publisher raised for job=%s event_type=%s (non-fatal)",
                job_id, event.get("type"),
            )

    async def _recover_interrupted(self) -> int:
        """At startup: every {pending, streaming} row predates this process
        and is unreachable (the in-memory submit registry didn't survive).
        Mark them all failed. Eng-spec §2.2."""
        n = await jobs_repo.mark_active_as_failed(
            error="server restarted before completion"
        )
        if n:
            logger.info("recovered %d stale generation_jobs at startup", n)
        return n

    async def _sweep_loop(self) -> None:
        """Periodic watchdog: streaming rows whose heartbeat_at predates the
        timeout are silently stalled (disk full, GPU hang). Mark them failed
        so the user sees an actionable error instead of a forever-spinner."""
        while not self._stopping:
            try:
                await asyncio.sleep(self.SWEEP_INTERVAL_S)
                if self._stopping:
                    break
                cutoff = datetime.now(timezone.utc) - self.HEARTBEAT_TIMEOUT
                n = await jobs_repo.mark_heartbeat_stale_as_failed(cutoff)
                if n:
                    logger.warning(
                        "heartbeat sweep: failed %d stalled streaming jobs", n
                    )
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("heartbeat sweep error (non-fatal)")


# Process-wide singleton. app.py imports this and calls start()/stop()
# from the FastAPI startup/shutdown hooks.
job_runner = JobRunner()
