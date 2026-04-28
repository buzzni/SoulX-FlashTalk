"""Tests for JobsPubSub: subscribe/publish fan-out, seq monotonic,
per-user cap, queue-full drop, sse_format wire shape."""
from __future__ import annotations

import asyncio
import json

import pytest

from modules.jobs_pubsub import (
    SUBSCRIBER_QUEUE_MAX,
    USER_CONN_CAP,
    CapExceededError,
    JobEvent,
    JobsPubSub,
    sse_format,
    sse_format_event,
)


# ── single subscriber ─────────────────────────────────────────────────

async def test_subscribe_then_publish_delivers_event():
    pubsub = JobsPubSub()
    async with pubsub.subscribe("job-1", "u1") as stream:
        await pubsub.publish("job-1", {"type": "candidate",
                                       "variant": {"image_id": "v1"}})
        evt = await asyncio.wait_for(stream.__anext__(), timeout=1.0)
        assert isinstance(evt, JobEvent)
        assert evt.seq == 1
        assert evt.type == "candidate"
        assert evt.payload["variant"]["image_id"] == "v1"


async def test_publish_before_subscribe_is_lost():
    """Late subscribers don't see past events — that's snapshot's job."""
    pubsub = JobsPubSub()
    await pubsub.publish("job-1", {"type": "candidate"})
    await pubsub.publish("job-1", {"type": "done"})
    async with pubsub.subscribe("job-1", "u1") as stream:
        # No events buffered — current_seq is 2 but the queue was empty
        # at subscribe time.
        await pubsub.publish("job-1", {"type": "post-subscribe"})
        evt = await asyncio.wait_for(stream.__anext__(), timeout=1.0)
        assert evt.seq == 3
        assert evt.type == "post-subscribe"


# ── multiple subscribers ──────────────────────────────────────────────

async def test_two_subscribers_same_job_both_receive():
    pubsub = JobsPubSub()
    received_a: list[JobEvent] = []
    received_b: list[JobEvent] = []

    async def consume(stream, sink):
        async for evt in stream:
            sink.append(evt)
            if evt.type == "done":
                return

    async with pubsub.subscribe("job-1", "u1") as a, \
               pubsub.subscribe("job-1", "u1") as b:
        ta = asyncio.create_task(consume(a, received_a))
        tb = asyncio.create_task(consume(b, received_b))
        await pubsub.publish("job-1", {"type": "candidate", "i": 1})
        await pubsub.publish("job-1", {"type": "candidate", "i": 2})
        await pubsub.publish("job-1", {"type": "done"})
        await asyncio.wait_for(asyncio.gather(ta, tb), timeout=2.0)

    assert [e.payload.get("i") for e in received_a if e.type == "candidate"] == [1, 2]
    assert [e.payload.get("i") for e in received_b if e.type == "candidate"] == [1, 2]
    assert received_a[-1].type == "done"
    assert received_b[-1].type == "done"


async def test_subscriber_isolation_across_jobs():
    """Publish to job-1 must not reach job-2 subscribers."""
    pubsub = JobsPubSub()
    received: list[JobEvent] = []

    async with pubsub.subscribe("job-2", "u1") as stream:
        await pubsub.publish("job-1", {"type": "candidate"})
        # Drain anything that landed in job-2's queue (should be nothing).
        try:
            evt = await asyncio.wait_for(stream.__anext__(), timeout=0.1)
            received.append(evt)
        except asyncio.TimeoutError:
            pass
    assert received == []


# ── seq monotonic ─────────────────────────────────────────────────────

async def test_seq_monotonic_per_job():
    pubsub = JobsPubSub()
    assert pubsub.current_seq("job-1") == 0
    await pubsub.publish("job-1", {"type": "a"})
    await pubsub.publish("job-1", {"type": "b"})
    await pubsub.publish("job-1", {"type": "c"})
    assert pubsub.current_seq("job-1") == 3
    # Different job has its own counter.
    assert pubsub.current_seq("job-2") == 0
    await pubsub.publish("job-2", {"type": "a"})
    assert pubsub.current_seq("job-2") == 1
    assert pubsub.current_seq("job-1") == 3


async def test_seq_advances_even_without_subscribers():
    """A publish with no live subscribers still increments the seq —
    this lets a late-subscribe + snapshot pair correctly identify which
    events are already reflected in the snapshot vs which are net-new."""
    pubsub = JobsPubSub()
    await pubsub.publish("job-1", {"type": "candidate"})
    await pubsub.publish("job-1", {"type": "candidate"})
    assert pubsub.current_seq("job-1") == 2


# ── per-user connection cap ──────────────────────────────────────────

async def test_user_cap_enforced():
    pubsub = JobsPubSub()
    contexts = []
    streams = []
    try:
        for i in range(USER_CONN_CAP):
            ctx = pubsub.subscribe(f"job-{i}", "u1")
            stream = await ctx.__aenter__()
            contexts.append(ctx)
            streams.append(stream)
        # 11th subscribe for the same user → CapExceededError.
        ctx = pubsub.subscribe("job-overflow", "u1")
        with pytest.raises(CapExceededError):
            await ctx.__aenter__()
    finally:
        for ctx in contexts:
            await ctx.__aexit__(None, None, None)


async def test_cap_decrements_on_unsubscribe():
    """After a context exits, the user's slot frees up and subsequent
    subscribes succeed."""
    pubsub = JobsPubSub()
    contexts = []
    try:
        for i in range(USER_CONN_CAP):
            ctx = pubsub.subscribe(f"job-{i}", "u1")
            await ctx.__aenter__()
            contexts.append(ctx)
        # Release one slot.
        await contexts.pop().__aexit__(None, None, None)
        # Now an 11th-attempt-from-the-other-side fits.
        ctx = pubsub.subscribe("job-after", "u1")
        await ctx.__aenter__()
        contexts.append(ctx)
    finally:
        for ctx in contexts:
            await ctx.__aexit__(None, None, None)


async def test_cap_is_per_user():
    """Different users have independent caps."""
    pubsub = JobsPubSub()
    contexts = []
    try:
        for i in range(USER_CONN_CAP):
            ctx = pubsub.subscribe(f"job-{i}", "u1")
            await ctx.__aenter__()
            contexts.append(ctx)
        # u2 still has all 10 slots open.
        ctx = pubsub.subscribe("job-other", "u2")
        await ctx.__aenter__()
        contexts.append(ctx)
    finally:
        for ctx in contexts:
            await ctx.__aexit__(None, None, None)


# ── queue full ────────────────────────────────────────────────────────

async def test_queue_full_drops_event_for_slow_subscriber(caplog):
    """A subscriber that never reads its queue eventually overflows. The
    publisher logs a warning and continues — other subscribers + the seq
    counter are unaffected."""
    pubsub = JobsPubSub()
    async with pubsub.subscribe("job-1", "u1") as _stream:
        # Fill the queue without consuming.
        for i in range(SUBSCRIBER_QUEUE_MAX):
            await pubsub.publish("job-1", {"type": "candidate", "i": i})
        # The next publish overflows: queue rejects, publisher logs.
        with caplog.at_level("WARNING", logger="modules.jobs_pubsub"):
            await pubsub.publish("job-1", {"type": "candidate", "i": "overflow"})
        warnings = [r for r in caplog.records if "queue full" in r.message]
        assert warnings, f"expected queue-full warning, got {caplog.records}"
        # Seq still advances — eng-spec §3.3 (gap detection is the client's job).
        assert pubsub.current_seq("job-1") == SUBSCRIBER_QUEUE_MAX + 1


# ── cleanup on exit ───────────────────────────────────────────────────

async def test_subscribe_cleanup_removes_subscription():
    pubsub = JobsPubSub()
    async with pubsub.subscribe("job-1", "u1") as _stream:
        assert "job-1" in pubsub._subs
        assert pubsub._user_conns["u1"] == 1
    # After exit: registries are clean.
    assert "job-1" not in pubsub._subs
    assert "u1" not in pubsub._user_conns


async def test_consumer_terminates_when_context_exits():
    """A subscriber consuming from the stream sees the iterator end when
    the context exits, not hang forever waiting for the next event."""
    pubsub = JobsPubSub()
    received: list[JobEvent] = []
    cancel_evt = asyncio.Event()

    async def consume_one(stream):
        try:
            async for evt in stream:
                received.append(evt)
                if evt.type == "stop":
                    return
        finally:
            cancel_evt.set()

    async with pubsub.subscribe("job-1", "u1") as stream:
        consumer = asyncio.create_task(consume_one(stream))
        await pubsub.publish("job-1", {"type": "candidate"})
        await pubsub.publish("job-1", {"type": "stop"})
        await asyncio.wait_for(consumer, timeout=2.0)
    await asyncio.wait_for(cancel_evt.wait(), timeout=1.0)
    assert [e.type for e in received] == ["candidate", "stop"]


# ── sse_format ────────────────────────────────────────────────────────

def test_sse_format_with_id():
    out = sse_format("candidate", '{"image_id":"v1"}', id=42)
    assert out == 'id: 42\nevent: candidate\ndata: {"image_id":"v1"}\n\n'


def test_sse_format_without_id():
    out = sse_format("snapshot", '{"state":"ready"}')
    assert out == 'event: snapshot\ndata: {"state":"ready"}\n\n'


def test_sse_format_event_packs_jobevent():
    evt = JobEvent(seq=7, type="done", payload={"batch_id": "b"})
    out = sse_format_event(evt)
    # Must include id: 7, event: done, and the JSON-serialized payload.
    assert "id: 7" in out
    assert "event: done" in out
    assert "data: " in out
    # Reparse the data line to confirm round-trip integrity.
    data_line = next(l for l in out.splitlines() if l.startswith("data: "))
    payload = json.loads(data_line[len("data: "):])
    assert payload == {"batch_id": "b"}


def test_sse_format_frame_terminator():
    """Every frame must end with \\n\\n — clients buffer until they see it."""
    out = sse_format("any", "payload")
    assert out.endswith("\n\n")
