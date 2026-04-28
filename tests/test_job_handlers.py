"""Tests for modules.job_handlers — adapters from /api/jobs input_blob to
the JobRunner event protocol.

This is the production-blocker class /simplify caught (host/composite
handlers were never registered). The regression net is:

  1. Each handler invokes the legacy generator with the right kwargs.
  2. _translate_legacy_event maps legacy event shapes (candidate/error/
     fatal/done with seed/path/url) to JobRunner shapes (candidate with
     variant dict, fatal, done with batch_id).

We mock the legacy generators so this is a pure unit test — no Gemini,
no GPU. The contract being verified is the input→event translation
that the runner depends on; eng-spec §2.2.
"""
from __future__ import annotations

import os
import tempfile

import pytest

from modules import job_handlers


def _seed_image(d, name="x.png"):
    p = os.path.join(d, name)
    with open(p, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + b"\0" * 16)
    return p


@pytest.fixture
def safe_paths(monkeypatch):
    """Set SAFE_ROOTS so safe_upload_path accepts the test fixtures."""
    import config
    tmp = tempfile.mkdtemp()
    monkeypatch.setattr(config, "SAFE_ROOTS", (tmp,))
    return tmp


# ── _translate_legacy_event direct tests ─────────────────────────────

async def _drain(gen):
    out = []
    async for evt in gen:
        out.append(evt)
    return out


async def test_translate_candidate_event_maps_to_variant_shape():
    legacy = {
        "type": "candidate", "seed": 42,
        "path": "/srv/v1.png", "url": "/u/v1.png",
    }
    out = await _drain(job_handlers._translate_legacy_event("job-1", legacy))
    assert len(out) == 1
    assert out[0]["type"] == "candidate"
    assert out[0]["variant"]["image_id"] == "v1"
    assert out[0]["variant"]["path"] == "/srv/v1.png"
    assert out[0]["variant"]["url"] == "/u/v1.png"
    assert out[0]["variant"]["seed"] == 42


async def test_translate_candidate_without_path_is_dropped():
    """Legacy 'candidate' without a path means the slot failed before
    the file landed. The runner has no variant to append; suppress."""
    legacy = {"type": "candidate", "seed": 42}
    out = await _drain(job_handlers._translate_legacy_event("job-1", legacy))
    assert out == []


async def test_translate_fatal_event_maps_to_runner_fatal():
    legacy = {"type": "fatal", "error": "GPU OOM", "status": 503}
    out = await _drain(job_handlers._translate_legacy_event("job-1", legacy))
    assert len(out) == 1
    assert out[0] == {"type": "fatal", "error": "GPU OOM"}


async def test_translate_fatal_without_error_field_uses_default():
    legacy = {"type": "fatal"}
    out = await _drain(job_handlers._translate_legacy_event("job-1", legacy))
    assert out[0]["type"] == "fatal"
    assert out[0]["error"] == "unknown"


async def test_translate_done_success_maps_to_runner_done():
    legacy = {"type": "done", "success_count": 4, "total": 4, "batch_id": "b-1"}
    out = await _drain(job_handlers._translate_legacy_event("job-1", legacy))
    assert len(out) == 1
    assert out[0] == {"type": "done", "batch_id": "b-1"}


async def test_translate_done_min_not_met_promotes_to_fatal():
    """min_success_met=False = the legacy 'partial failure' signal.
    The runner has no equivalent of a partial-success done — translate
    to fatal so the user sees an actionable error."""
    legacy = {
        "type": "done", "min_success_met": False,
        "success_count": 1, "total": 4,
    }
    out = await _drain(job_handlers._translate_legacy_event("job-1", legacy))
    assert len(out) == 1
    assert out[0]["type"] == "fatal"
    assert "1/4" in out[0]["error"]


async def test_translate_done_uses_job_id_when_batch_id_missing():
    legacy = {"type": "done", "success_count": 4, "total": 4}
    out = await _drain(job_handlers._translate_legacy_event("job-abc", legacy))
    assert out[0]["batch_id"] == "job-abc"


async def test_translate_per_slot_error_is_suppressed():
    """Legacy emits a per-slot 'error' for individual failures. The
    runner protocol has no slot-level error; the variant just won't
    appear in the cache. Suppress (logged at info level)."""
    legacy = {"type": "error", "seed": 42, "error": "rate limited"}
    out = await _drain(job_handlers._translate_legacy_event("job-1", legacy))
    assert out == []


async def test_translate_unknown_event_type_is_ignored():
    legacy = {"type": "init", "seeds": [1, 2, 3, 4]}
    out = await _drain(job_handlers._translate_legacy_event("job-1", legacy))
    assert out == []


# ── host_job_handler integration with mocked generator ──────────────

async def test_host_job_handler_drives_legacy_stream(monkeypatch, safe_paths):
    """Verify the handler wires the input_blob through to
    stream_host_candidates and translates each event correctly."""
    saved = _seed_image(safe_paths, "host.png")
    captured_kwargs: dict = {}

    async def fake_stream(**kwargs):
        captured_kwargs.update(kwargs)
        yield {"type": "candidate", "seed": 1, "path": saved, "url": "/u/h.png"}
        yield {"type": "done", "success_count": 1, "total": 1, "batch_id": "bh"}

    monkeypatch.setattr("modules.host_generator.stream_host_candidates", fake_stream)

    blob = {
        "mode": "v1",
        "prompt": "a friendly host",
        "n": 4,
        "seeds": [1, 2, 3, 4],
        "imageSize": "1K",
        "faceStrength": 0.7,
        "outfitStrength": 0.7,
    }
    out = []
    async for evt in job_handlers.host_job_handler("job-h", blob):
        out.append(evt)

    # Legacy candidate translated to runner variant shape.
    assert out[0]["type"] == "candidate"
    assert out[0]["variant"]["seed"] == 1
    assert out[1] == {"type": "done", "batch_id": "bh"}
    # Kwargs forwarded correctly.
    assert captured_kwargs["mode"] == "v1"
    assert captured_kwargs["text_prompt"] == "a friendly host"
    assert captured_kwargs["seeds"] == [1, 2, 3, 4]
    assert captured_kwargs["n"] == 4


async def test_host_job_handler_sanitizes_path_fields(monkeypatch, safe_paths):
    """Path fields are re-resolved through safe_upload_path inside the
    handler (defense-in-depth per eng-spec §8). Confirms a malicious
    path still raises before reaching stream_host_candidates."""
    async def fake_stream(**_):
        yield {"type": "done", "success_count": 0, "total": 0}

    monkeypatch.setattr("modules.host_generator.stream_host_candidates", fake_stream)

    blob = {"mode": "v1", "faceRefPath": "/etc/passwd"}
    with pytest.raises(Exception):  # safe_upload_path raises HTTPException
        async for _ in job_handlers.host_job_handler("job-x", blob):
            pass


async def test_composite_job_handler_drives_legacy_stream(monkeypatch, safe_paths):
    saved_host = _seed_image(safe_paths, "host.png")
    saved_p1 = _seed_image(safe_paths, "p1.png")
    captured_kwargs: dict = {}

    async def fake_stream(**kwargs):
        captured_kwargs.update(kwargs)
        yield {"type": "candidate", "seed": 5, "path": saved_p1, "url": "/u/c1.png"}
        yield {"type": "done", "success_count": 1, "total": 1, "batch_id": "bc"}

    monkeypatch.setattr(
        "modules.composite_generator.stream_composite_candidates",
        fake_stream,
    )

    blob = {
        "hostImagePath": saved_host,
        "productImagePaths": [saved_p1],
        "backgroundType": "prompt",
        "backgroundPrompt": "studio",
        "direction": "front",
        "shot": "bust",
        "angle": "eye",
        "n": 4,
        "rembg": True,
    }
    out = []
    async for evt in job_handlers.composite_job_handler("job-c", blob):
        out.append(evt)

    assert out[0]["type"] == "candidate"
    assert out[0]["variant"]["seed"] == 5
    assert out[1] == {"type": "done", "batch_id": "bc"}
    assert captured_kwargs["host_image_path"] == saved_host
    assert captured_kwargs["product_image_paths"] == [saved_p1]
    assert captured_kwargs["background_type"] == "prompt"
    assert captured_kwargs["rembg_products"] is True


async def test_composite_handler_default_field_values(monkeypatch, safe_paths):
    """Optional fields fall back to sane defaults so an underspecified
    blob doesn't KeyError."""
    saved_host = _seed_image(safe_paths, "host.png")

    async def fake_stream(**kwargs):
        # Pull defaults from the call.
        assert kwargs["shot"] == "bust"
        assert kwargs["angle"] == "eye"
        assert kwargs["rembg_products"] is True
        assert kwargs["n"] == 4
        yield {"type": "done", "success_count": 0, "total": 0}

    monkeypatch.setattr(
        "modules.composite_generator.stream_composite_candidates",
        fake_stream,
    )

    blob = {"hostImagePath": saved_host, "backgroundType": "prompt"}
    out = []
    async for evt in job_handlers.composite_job_handler("job-c", blob):
        out.append(evt)
    assert out[0]["type"] == "done"
