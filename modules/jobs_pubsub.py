"""In-process pub/sub for generation_jobs SSE events.

Phase A step 6 of streaming-resume (eng-spec §3). Owns the worker → SSE
fan-out: JobRunner.publish writes here, the SSE endpoint (step 7)
subscribes via the async context manager.

Single-process only. Per-job sequence numbers are in-memory; if the
process restarts, seqs reset and any client mid-resume falls back to a
full snapshot fetch (eng-spec §3.3 trade-off). v2.1 will swap this for a
Redis-backed pubsub to support multi-worker.

Eng-spec §3.2 race-free SSE handshake (subscribe FIRST, then snapshot,
then drain buffered events with seq > snap.seq) is implemented in step 7.
This module just exposes the primitives.

Per-user connection cap (eng-spec §8): each user can have at most 10
concurrent SSE subscriptions. The 11th raises CapExceededError so the
endpoint can return 429.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncIterator, Optional

logger = logging.getLogger(__name__)


# Per eng-spec §3.3 — bounded queue per subscriber. If a slow client lets
# 1024 events stack up, we log + drop rather than block the publisher.
# The DB row stays authoritative; the client can recover via snapshot.
SUBSCRIBER_QUEUE_MAX = 1024

# Per-user concurrent SSE connection cap (eng-spec §8). 429 above this.
USER_CONN_CAP = 10


class CapExceededError(Exception):
    """Per-user concurrent SSE subscription cap exceeded. Endpoint maps to 429."""


@dataclass(frozen=True)
class JobEvent:
    """One pubsub event with its monotonic per-job seq.

    `payload` is the dict the publisher sent — typically
    {"type": "candidate"|"done"|"fatal", ...}. The seq is assigned at
    publish time so subscribers can detect gaps (lost-due-to-overflow)
    and resync via a snapshot fetch."""

    seq: int
    type: str
    payload: dict


# Sentinel pushed into a subscriber's queue when the context manager exits.
# Lets the _stream() async iterator break cleanly even if no more publishes
# arrive. Type-check uses identity, not equality.
_END = object()


class JobsPubSub:
    """Per-process fan-out for job event streams.

    Methods:
      - subscribe(job_id, user_id): async context manager yielding an
        async iterator of JobEvents. Cleans up the subscriber on exit.
      - publish(job_id, payload): seq++, fans out to every subscriber.
      - current_seq(job_id): the seq of the most recent publish (0 if
        the job has never published). Step 7 pairs this with the snapshot
        fetch to make the SSE handshake race-free.
    """

    def __init__(self) -> None:
        self._subs: dict[str, list[asyncio.Queue]] = defaultdict(list)
        self._seqs: dict[str, int] = defaultdict(int)
        self._user_conns: dict[str, int] = defaultdict(int)
        # Reverse map so unsubscribe knows which user to decrement.
        self._queue_owner: dict[int, str] = {}

    # ── Public API ────────────────────────────────────────────────────

    @asynccontextmanager
    async def subscribe(
        self, job_id: str, user_id: str,
    ) -> AsyncIterator[AsyncIterator[JobEvent]]:
        """Register a subscriber for `job_id` and yield an async iterator.

        Eng-spec §8: per-user connection cap is enforced atomically here.
        The 11th concurrent subscribe for a single user raises
        CapExceededError before any queue is created, so the caller can
        translate to 429 without leaking a half-registered queue.
        """
        if self._user_conns[user_id] >= USER_CONN_CAP:
            raise CapExceededError(
                f"user {user_id!r} already has {USER_CONN_CAP} active "
                f"SSE subscriptions"
            )
        q: asyncio.Queue = asyncio.Queue(maxsize=SUBSCRIBER_QUEUE_MAX)
        self._subs[job_id].append(q)
        self._user_conns[user_id] += 1
        self._queue_owner[id(q)] = user_id
        try:
            yield self._stream(q)
        finally:
            # Cleanup runs even on cancellation — the async-with semantic
            # guarantees __aexit__ fires.
            self._subs[job_id].remove(q)
            if not self._subs[job_id]:
                del self._subs[job_id]
            self._user_conns[user_id] -= 1
            if self._user_conns[user_id] <= 0:
                del self._user_conns[user_id]
            self._queue_owner.pop(id(q), None)
            # Drop the END sentinel into the queue too, in case the
            # consumer is mid-await (it'll see _END and break). Best-effort:
            # if the queue is full we don't block.
            try:
                q.put_nowait(_END)
            except asyncio.QueueFull:
                pass

    async def publish(self, job_id: str, payload: dict) -> None:
        """Assign a fresh seq, then fan out to every current subscriber.

        QueueFull on a slow subscriber → log warning, drop event for
        that subscriber, continue. The seq still advances so other
        subscribers see a coherent monotonic sequence."""
        self._seqs[job_id] = self._seqs.get(job_id, 0) + 1
        evt = JobEvent(
            seq=self._seqs[job_id],
            type=str(payload.get("type", "")),
            payload=dict(payload),
        )
        for q in self._subs.get(job_id, ()):
            try:
                q.put_nowait(evt)
            except asyncio.QueueFull:
                logger.warning(
                    "subscriber queue full for job=%s seq=%s type=%s; dropping",
                    job_id, evt.seq, evt.type,
                )

    def current_seq(self, job_id: str) -> int:
        """The seq of the last publish for `job_id`, or 0 if none yet.

        Step 7's SSE handshake reads this immediately after the snapshot
        fetch. Any event with seq <= snap.seq is already reflected in the
        snapshot; subscribers replay only events with strictly greater
        seq (eng-spec §3.2)."""
        return self._seqs.get(job_id, 0)

    # ── Internals ─────────────────────────────────────────────────────

    async def _stream(self, q: asyncio.Queue) -> AsyncIterator[JobEvent]:
        """Consume the subscriber's queue until the END sentinel arrives.

        The sentinel is dropped in by subscribe()'s finally block on
        cleanup, so an iterator that's been exhausted (queue went idle
        and the context manager exited) terminates instead of hanging."""
        while True:
            evt = await q.get()
            if evt is _END:
                return
            yield evt


# Process-wide singleton. JobRunner.set_publisher binds publish() in
# app.py startup_event. Tests instantiate their own JobsPubSub for
# isolation.
jobs_pubsub = JobsPubSub()


# ── SSE wire format ───────────────────────────────────────────────────

def sse_format(
    event: str, data: str, id: Optional[int] = None,
) -> str:
    """Encode one SSE event frame per W3C Server-Sent Events spec.

    Eng-spec §3.2 uses three lines + a trailing blank line:
      id: <seq>          (optional; client persists into Last-Event-ID)
      event: <type>      (host-side dispatch hint)
      data: <json>       (a single line of JSON; multi-line data needs
                          one `data:` line per line, not relevant here)

    The trailing `\n\n` is what tells the client that this frame is
    complete — without it the client buffers indefinitely.
    """
    lines: list[str] = []
    if id is not None:
        lines.append(f"id: {id}")
    lines.append(f"event: {event}")
    lines.append(f"data: {data}")
    return "\n".join(lines) + "\n\n"


def sse_format_event(event: JobEvent) -> str:
    """Convenience: format a JobEvent (seq + type + dict payload) into the
    on-the-wire frame the SSE endpoint will yield. Pulled out so step 7
    can reuse it without re-importing json."""
    return sse_format(
        event.type, json.dumps(event.payload, ensure_ascii=False),
        id=event.seq,
    )
