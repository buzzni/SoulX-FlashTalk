"""Phase 4 — SSE /api/progress/{task_id} stream.

Regression coverage for the heartbeat fix (April 2026). Long video-gen
runs would silently die mid-stream with ERR_INCOMPLETE_CHUNKED_ENCODING
because the Vite dev proxy times out idle upstream connections at 120s
and worker updates can be 60-180s apart during MultiTalk inference.
"""
from __future__ import annotations

import asyncio
import pytest

pytestmark = pytest.mark.phase4


@pytest.mark.asyncio
async def test_sse_emits_data_events_then_terminates_on_complete(monkeypatch):
    """Happy path: yields each queued update as `data: {...}` then stops on
    stage='complete'. No heartbeats needed when updates are flowing."""
    import app as app_mod

    monkeypatch.setattr(app_mod, "SSE_POLL_SEC", 0.0)
    monkeypatch.setattr(app_mod, "SSE_HEARTBEAT_SEC", 999.0)

    app_mod.task_states["t1"] = {
        "stage": "complete",
        "progress": 1.0,
        "message": "done",
        "error": None,
        "updates": [
            {"stage": "queued", "progress": 0.0, "message": "queued"},
            {"stage": "complete", "progress": 1.0, "message": "done"},
        ],
        "output_path": None,
    }

    frames = []
    async for f in app_mod._progress_event_generator("t1"):
        frames.append(f)

    assert len(frames) == 2
    assert all(f.startswith("data: ") for f in frames)
    assert "queued" in frames[0]
    assert "complete" in frames[1]


@pytest.mark.asyncio
async def test_sse_sends_heartbeat_when_no_updates(monkeypatch):
    """If no new updates arrive within SSE_HEARTBEAT_SEC, a `: heartbeat`
    comment frame is emitted. This is what keeps the Vite proxy from
    killing the upstream connection during long silent stretches."""
    import app as app_mod

    monkeypatch.setattr(app_mod, "SSE_POLL_SEC", 0.0)
    monkeypatch.setattr(app_mod, "SSE_HEARTBEAT_SEC", 0.01)

    app_mod.task_states["t2"] = {
        "stage": "generating",
        "progress": 0.5,
        "message": "rendering...",
        "error": None,
        "updates": [{"stage": "generating", "progress": 0.5, "message": "rendering..."}],
        "output_path": None,
    }

    gen = app_mod._progress_event_generator("t2")
    first = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
    assert first.startswith("data: ")
    second = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
    assert second.startswith(": heartbeat")

    app_mod.task_states["t2"]["stage"] = "complete"
    app_mod.task_states["t2"]["updates"].append(
        {"stage": "complete", "progress": 1.0, "message": "done"}
    )
    final = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
    assert "complete" in final
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(gen.__anext__(), timeout=1.0)


@pytest.mark.asyncio
async def test_sse_breaks_when_task_vanishes(monkeypatch):
    """If task_states is cleaned up out from under the generator, exit
    cleanly rather than yielding forever — caller sees stream close, not
    a hang."""
    import app as app_mod

    monkeypatch.setattr(app_mod, "SSE_POLL_SEC", 0.0)
    monkeypatch.setattr(app_mod, "SSE_HEARTBEAT_SEC", 999.0)

    app_mod.task_states["t3"] = {
        "stage": "generating",
        "progress": 0.5,
        "message": "x",
        "error": None,
        "updates": [{"stage": "generating", "progress": 0.5, "message": "x"}],
        "output_path": None,
    }

    gen = app_mod._progress_event_generator("t3")
    first = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
    assert first.startswith("data: ")
    app_mod.task_states.pop("t3", None)
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(gen.__anext__(), timeout=1.0)
