"""Phase 4 — SSE /api/progress/{task_id} stream."""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.phase4


@pytest.mark.skip(reason="TDD placeholder — queued→complete sequence")
def test_sse_emits_queued_running_complete_events():
    ...


@pytest.mark.skip(reason="TDD placeholder — client disconnect cleanup")
def test_sse_client_disconnect_prunes_task_state():
    """task_states dict does not leak memory when client disconnects."""
    ...


@pytest.mark.skip(reason="TDD placeholder — orphan heartbeat")
def test_sse_orphan_task_detected_by_heartbeat():
    """Task without heartbeat in 5min flagged as orphan."""
    ...
