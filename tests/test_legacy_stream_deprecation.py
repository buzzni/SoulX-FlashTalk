"""Phase A step 12: deprecation markers on legacy SSE endpoints.

The legacy /api/host/generate/stream and /api/composite/generate/stream
stay live until Phase C cutover (sunset 2026-06-30). These tests confirm
the markers are in place and the endpoints still work side by side with
the new /api/jobs surface (dual-mode)."""
from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def client(monkeypatch, tmp_path):
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    examples = tmp_path / "examples"
    saved = outputs / "hosts" / "saved"
    for d in (uploads, outputs, examples, saved):
        d.mkdir(parents=True, exist_ok=True)

    import config
    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(examples))
    monkeypatch.setattr(
        config, "SAFE_ROOTS",
        (str(uploads), str(outputs), str(examples)),
    )

    # Swap the heavyweight generators for fakes so the endpoints exercise
    # the headers + log path without invoking Gemini / GPU code.
    async def _fake_host_stream(*args, **kwargs):
        yield {"type": "candidate", "image_id": "x"}
        yield {"type": "done"}

    async def _fake_composite_stream(*args, **kwargs):
        yield {"type": "init", "direction": "front"}
        yield {"type": "candidate", "image_id": "y"}
        yield {"type": "done"}

    monkeypatch.setattr(
        "modules.host_generator.stream_host_candidates",
        _fake_host_stream,
    )
    monkeypatch.setattr(
        "modules.composite_generator.stream_composite_candidates",
        _fake_composite_stream,
    )

    # Stub job_runner.submit so the dual-mode test below stays in 'pending'.
    async def _noop(jid):
        return None
    monkeypatch.setattr(
        "modules.job_runner.job_runner.submit", _noop
    )

    from fastapi.testclient import TestClient
    import app as app_module

    with TestClient(app_module.app) as tc:
        yield tc, uploads


# ── headers ───────────────────────────────────────────────────────────

_HOST_FORM = {
    "mode": "v1",
    "prompt": "x",
    "n": "4",
    "imageSize": "1K",
    "faceStrength": "0.7",
    "outfitStrength": "0.7",
}

_COMPOSITE_FORM_BASE = {
    "backgroundType": "prompt",
    "backgroundPrompt": "studio",
    "direction": "front",
    "shot": "bust",
    "angle": "eye",
    "n": "4",
    "imageSize": "1K",
    "productImagePaths": "[]",
}


def test_host_stream_carries_deprecation_headers(client):
    tc, _ = client
    r = tc.post("/api/host/generate/stream", data=_HOST_FORM)
    assert r.status_code == 200
    assert r.headers["deprecation"] == "true"
    assert r.headers["sunset"] == "Tue, 30 Jun 2026 00:00:00 GMT"
    assert "/api/jobs" in r.headers["link"]
    assert "successor-version" in r.headers["link"]


def test_composite_stream_carries_deprecation_headers(client):
    tc, uploads = client
    host = uploads / "host.png"
    host.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 16)
    form = dict(_COMPOSITE_FORM_BASE)
    form["hostImagePath"] = str(host)
    r = tc.post("/api/composite/generate/stream", data=form)
    assert r.status_code == 200
    assert r.headers["deprecation"] == "true"
    assert r.headers["sunset"] == "Tue, 30 Jun 2026 00:00:00 GMT"
    assert "successor-version" in r.headers["link"]


# ── log warning ───────────────────────────────────────────────────────

def test_host_stream_logs_deprecation_warning(client, caplog):
    tc, _ = client
    with caplog.at_level("WARNING", logger="app"):
        tc.post("/api/host/generate/stream", data=_HOST_FORM)
    msgs = [r.message for r in caplog.records if "DEPRECATED" in r.message]
    assert msgs, f"expected a deprecation warning, got {caplog.records}"
    assert "/api/host/generate/stream" in msgs[0]
    # The new endpoint path is named in the warning so log readers can act.
    assert "/api/jobs" in msgs[0]


def test_composite_stream_logs_deprecation_warning(client, caplog):
    tc, uploads = client
    host = uploads / "host.png"
    host.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 16)
    form = dict(_COMPOSITE_FORM_BASE)
    form["hostImagePath"] = str(host)
    with caplog.at_level("WARNING", logger="app"):
        tc.post("/api/composite/generate/stream", data=form)
    msgs = [r.message for r in caplog.records if "DEPRECATED" in r.message]
    assert msgs
    assert "/api/composite/generate/stream" in msgs[0]


# ── dual-mode: both old and new live ──────────────────────────────────

def test_dual_mode_old_and_new_endpoints_both_work(client):
    """The Phase C cutover requires both endpoints to be live so the
    frontend can flip the feature flag without a coordinated deploy."""
    tc, uploads = client
    face = uploads / "face.png"
    face.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 16)

    # New: POST /api/jobs returns 200 + pending snapshot.
    new = tc.post("/api/jobs", json={
        "kind": "host",
        "input": {
            "mode": "v1", "prompt": "x", "n": 4,
            "seeds": [1, 2, 3, 4],
            "faceRefPath": str(face),
        },
    })
    assert new.status_code == 200
    assert new.json()["state"] == "pending"

    # Old: legacy stream endpoint still serves SSE.
    old = tc.post("/api/host/generate/stream", data=_HOST_FORM)
    assert old.status_code == 200
    assert old.headers["content-type"].startswith("text/event-stream")
    assert old.headers["deprecation"] == "true"


# ── headers preserve original SSE behavior ────────────────────────────

def test_host_stream_keeps_original_sse_headers(client):
    """Adding deprecation headers must not displace Cache-Control or
    X-Accel-Buffering — those keep the stream from being buffered by
    proxies/CDNs."""
    tc, _ = client
    r = tc.post("/api/host/generate/stream", data=_HOST_FORM)
    assert r.headers["cache-control"] == "no-cache"
    assert r.headers["x-accel-buffering"] == "no"
    assert r.headers["content-type"].startswith("text/event-stream")
