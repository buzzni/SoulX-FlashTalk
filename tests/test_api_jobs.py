"""Tests for POST /api/jobs (kind='host') — eng-spec §8 + §6.5 dedupe."""
from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture
def client(monkeypatch, tmp_path):
    """TestClient with redirected upload/output dirs and a stubbed runner.

    submit() is no-op'd so jobs stay in 'pending' state and the dedupe
    semantics can be observed without race against the runner's _run_one
    transition. JobRunner integration is covered in test_job_runner.py."""
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    examples = tmp_path / "examples"
    for d in (uploads, outputs, examples):
        d.mkdir(parents=True, exist_ok=True)

    import config

    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(examples))
    monkeypatch.setattr(config, "SAFE_ROOTS",
                        (str(uploads), str(outputs), str(examples)))

    from fastapi.testclient import TestClient
    import app as app_module

    async def _noop_submit(job_id: str) -> None:
        return None

    monkeypatch.setattr(
        "modules.job_runner.job_runner.submit", _noop_submit
    )

    with TestClient(app_module.app) as tc:
        yield tc, uploads


def _seed_image(uploads: Path, name: str = "face.png") -> Path:
    p = uploads / name
    p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 16)
    return p


def _host_payload(face_path: Path, **overrides) -> dict:
    body = {
        "kind": "host",
        "input": {
            "mode": "v1",
            "prompt": "a friendly host",
            "faceRefPath": str(face_path),
            "n": 4,
            "seeds": [1, 2, 3, 4],
        },
    }
    body["input"].update(overrides)
    return body


# ── happy path ────────────────────────────────────────────────────────

def test_create_host_job_returns_pending(client):
    tc, uploads = client
    face = _seed_image(uploads)
    r = tc.post("/api/jobs", json=_host_payload(face))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["state"] == "pending"
    assert body["kind"] == "host"
    assert body["user_id"] == "testuser"
    assert isinstance(body["id"], str) and len(body["id"]) >= 8
    assert body["variants"] == []
    assert body["input_hash"]
    # Public shape never leaks the input_blob — only input_hash.
    assert "input_blob" not in body


def test_response_paths_are_canonicalized(client):
    """faceRefPath in the stored input_blob is the realpath, so the worker
    replays the same path the API saw — defense against symlink games."""
    tc, uploads = client
    # Create a symlink to face.png inside uploads.
    face = _seed_image(uploads)
    link = uploads / "alias.png"
    link.symlink_to(face)
    r = tc.post("/api/jobs", json=_host_payload(link))
    assert r.status_code == 200
    # Two POSTs — one with the link, one with the real path — must dedupe
    # because the stored input_blob holds the realpath.
    r2 = tc.post("/api/jobs", json=_host_payload(face))
    assert r2.status_code == 200
    assert r.json()["id"] == r2.json()["id"]


# ── dedupe-by-reuse ───────────────────────────────────────────────────

def test_dedupe_same_payload_returns_same_id(client):
    tc, uploads = client
    face = _seed_image(uploads)
    a = tc.post("/api/jobs", json=_host_payload(face)).json()
    b = tc.post("/api/jobs", json=_host_payload(face)).json()
    assert a["id"] == b["id"]
    assert a["input_hash"] == b["input_hash"]


def test_different_seeds_create_distinct_jobs(client):
    """Re-roll changes seeds → new input_hash → new job. The dedupe key is
    the canonical input, not just the prompt + reference paths."""
    tc, uploads = client
    face = _seed_image(uploads)
    a = tc.post("/api/jobs", json=_host_payload(face, seeds=[1, 2, 3, 4]))
    b = tc.post("/api/jobs", json=_host_payload(face, seeds=[5, 6, 7, 8]))
    assert a.status_code == 200 and b.status_code == 200
    assert a.json()["id"] != b.json()["id"]
    assert a.json()["input_hash"] != b.json()["input_hash"]


def test_dedupe_ignores_optional_none_fields(client):
    """Canonicalization drops None-valued fields. Two payloads that differ
    only by an explicit-null vs absent field land on the same hash."""
    tc, uploads = client
    face = _seed_image(uploads)
    payload_a = _host_payload(face)
    payload_b = _host_payload(face)
    payload_b["input"]["temperature"] = None  # explicit null
    a = tc.post("/api/jobs", json=payload_a)
    b = tc.post("/api/jobs", json=payload_b)
    assert a.json()["id"] == b.json()["id"]


# ── path traversal / safe_upload_path ─────────────────────────────────

def test_path_traversal_rejected(client):
    """A faceRefPath outside SAFE_ROOTS gets safe_upload_path's 400."""
    tc, _ = client
    bad = {
        "kind": "host",
        "input": {
            "mode": "v1",
            "prompt": "x",
            "faceRefPath": "/etc/passwd",
            "n": 4,
            "seeds": [1],
        },
    }
    r = tc.post("/api/jobs", json=bad)
    assert r.status_code == 400
    assert "allowed directory" in r.text.lower()


def test_relative_path_traversal_rejected(client):
    tc, uploads = client
    _seed_image(uploads)
    bad = {
        "kind": "host",
        "input": {
            "mode": "v1",
            "prompt": "x",
            "faceRefPath": str(uploads / ".." / ".." / "etc" / "passwd"),
            "n": 4,
            "seeds": [1],
        },
    }
    r = tc.post("/api/jobs", json=bad)
    assert r.status_code == 400


def test_no_path_field_is_ok(client):
    """Path fields are optional. Pure prompt-driven host gen should work."""
    tc, _ = client
    body = {
        "kind": "host",
        "input": {
            "mode": "v1",
            "prompt": "a host with no reference",
            "n": 4,
            "seeds": [1, 2, 3, 4],
        },
    }
    r = tc.post("/api/jobs", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "pending"


# ── shape validation (Pydantic 422) ───────────────────────────────────

def test_unknown_kind_rejected(client):
    tc, uploads = client
    face = _seed_image(uploads)
    body = _host_payload(face)
    body["kind"] = "weird"
    r = tc.post("/api/jobs", json=body)
    # Pydantic discriminator literal mismatch → 422.
    assert r.status_code == 422


def test_unknown_input_field_rejected(client):
    """extra='forbid' on HostJobInput catches typos like faceRefpath."""
    tc, uploads = client
    face = _seed_image(uploads)
    body = _host_payload(face)
    body["input"]["faceRefpath"] = str(face)  # lowercase 'p' typo
    r = tc.post("/api/jobs", json=body)
    assert r.status_code == 422


def test_missing_required_field_rejected(client):
    """mode is required by HostJobInput."""
    tc, uploads = client
    face = _seed_image(uploads)
    body = _host_payload(face)
    body["input"].pop("mode")
    r = tc.post("/api/jobs", json=body)
    assert r.status_code == 422


# ── size cap ──────────────────────────────────────────────────────────

def test_input_too_large_rejected(client):
    """eng-spec §7: serialized input cap is 256KB."""
    tc, uploads = client
    face = _seed_image(uploads)
    body = _host_payload(face)
    # Stuff prompt with ~300KB of text.
    body["input"]["prompt"] = "x" * 300_000
    r = tc.post("/api/jobs", json=body)
    assert r.status_code == 413
    assert "too large" in r.text.lower()


# ── multi-user scoping ────────────────────────────────────────────────

def test_dedupe_scoped_per_user(client, monkeypatch):
    """Two users posting the same payload get distinct rows.

    The conftest pins user_id='testuser' onto request.state.user via the
    bypass middleware. We swap the bypass for a second user mid-test and
    re-post to assert per-user scoping."""
    tc, uploads = client
    face = _seed_image(uploads)
    a = tc.post("/api/jobs", json=_host_payload(face)).json()

    other = {
        "user_id": "otheruser", "display_name": "Other",
        "role": "member", "is_active": True,
        "approval_status": "approved",
        "subscriptions": ["platform", "studio"],
        "studio_token_version": 0, "hashed_password": "",
    }

    async def _bypass_other(req, call_next):
        req.state.user = dict(other)
        return await call_next(req)

    monkeypatch.setattr("modules.auth.auth_middleware", _bypass_other)
    b = tc.post("/api/jobs", json=_host_payload(face)).json()
    assert a["id"] != b["id"]
    assert b["user_id"] == "otheruser"


# ── runner submit integration (smoke) ─────────────────────────────────

def test_runner_submit_invoked_on_fresh_create(client, monkeypatch):
    """Fresh row → submit gets called. Dedupe-hit → submit NOT re-invoked."""
    tc, uploads = client
    face = _seed_image(uploads)

    calls: list[str] = []

    async def _record_submit(job_id: str) -> None:
        calls.append(job_id)

    monkeypatch.setattr(
        "modules.job_runner.job_runner.submit", _record_submit
    )

    a = tc.post("/api/jobs", json=_host_payload(face)).json()
    b = tc.post("/api/jobs", json=_host_payload(face)).json()
    assert a["id"] == b["id"]  # dedupe hit
    assert calls == [a["id"]]  # submit called once (fresh insert only)


# ── composite (step 4) ────────────────────────────────────────────────

def _composite_payload(host_path: Path, products: list[Path], **overrides) -> dict:
    body = {
        "kind": "composite",
        "input": {
            "hostImagePath": str(host_path),
            "productImagePaths": [str(p) for p in products],
            "backgroundType": "prompt",
            "backgroundPrompt": "modern showroom",
            "direction": "front",
            "shot": "bust",
            "angle": "eye",
            "n": 4,
            "rembg": True,
            "seeds": [10, 11, 12, 13],
        },
    }
    body["input"].update(overrides)
    return body


def test_create_composite_job_returns_pending(client):
    tc, uploads = client
    host = _seed_image(uploads, "host.png")
    p1 = _seed_image(uploads, "p1.png")
    p2 = _seed_image(uploads, "p2.png")
    r = tc.post("/api/jobs", json=_composite_payload(host, [p1, p2]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "composite"
    assert body["state"] == "pending"
    assert body["user_id"] == "testuser"


def test_composite_dedupe_same_payload(client):
    tc, uploads = client
    host = _seed_image(uploads, "host.png")
    p1 = _seed_image(uploads, "p1.png")
    a = tc.post("/api/jobs", json=_composite_payload(host, [p1])).json()
    b = tc.post("/api/jobs", json=_composite_payload(host, [p1])).json()
    assert a["id"] == b["id"]


def test_composite_product_path_traversal_rejected(client):
    """Each item in productImagePaths runs through safe_upload_path."""
    tc, uploads = client
    host = _seed_image(uploads, "host.png")
    legit = _seed_image(uploads, "p1.png")
    body = _composite_payload(host, [legit])
    body["input"]["productImagePaths"] = [str(legit), "/etc/passwd"]
    r = tc.post("/api/jobs", json=body)
    assert r.status_code == 400
    assert "allowed directory" in r.text.lower()


def test_composite_host_path_traversal_rejected(client):
    tc, uploads = client
    legit = _seed_image(uploads, "p1.png")
    body = _composite_payload(uploads / "x.png", [legit])
    body["input"]["hostImagePath"] = "/etc/passwd"
    r = tc.post("/api/jobs", json=body)
    assert r.status_code == 400


def test_composite_background_upload_path_validated(client):
    """backgroundUploadPath is a scalar path field — gets sanitized too."""
    tc, uploads = client
    host = _seed_image(uploads, "host.png")
    bg = _seed_image(uploads, "bg.png")
    body = _composite_payload(host, [])
    body["input"]["backgroundType"] = "upload"
    body["input"]["backgroundUploadPath"] = str(bg)
    r = tc.post("/api/jobs", json=body)
    assert r.status_code == 200, r.text


def test_composite_background_upload_traversal_rejected(client):
    tc, uploads = client
    host = _seed_image(uploads, "host.png")
    body = _composite_payload(host, [])
    body["input"]["backgroundType"] = "upload"
    body["input"]["backgroundUploadPath"] = "/etc/passwd"
    r = tc.post("/api/jobs", json=body)
    assert r.status_code == 400


def test_composite_missing_required_field_rejected(client):
    """backgroundType is required by CompositeJobInput."""
    tc, uploads = client
    host = _seed_image(uploads, "host.png")
    body = _composite_payload(host, [])
    body["input"].pop("backgroundType")
    r = tc.post("/api/jobs", json=body)
    assert r.status_code == 422


def test_composite_invalid_background_type_rejected(client):
    """backgroundType is a Literal — only preset/upload/prompt allowed."""
    tc, uploads = client
    host = _seed_image(uploads, "host.png")
    body = _composite_payload(host, [])
    body["input"]["backgroundType"] = "weird"
    r = tc.post("/api/jobs", json=body)
    assert r.status_code == 422


def test_composite_extra_field_rejected(client):
    """extra='forbid' on CompositeJobInput catches typos / spec drift."""
    tc, uploads = client
    host = _seed_image(uploads, "host.png")
    body = _composite_payload(host, [])
    body["input"]["productPath"] = str(host)  # singular — wrong field name
    r = tc.post("/api/jobs", json=body)
    assert r.status_code == 422


def test_host_and_composite_partition_dedupe_space(client):
    """Even if a host blob and a composite blob somehow serialized
    identically, the kind is mixed into the input_hash so they live in
    distinct dedupe spaces and never collide on the partial unique index."""
    tc, uploads = client
    face = _seed_image(uploads, "face.png")
    p1 = _seed_image(uploads, "p1.png")

    h = tc.post("/api/jobs", json=_host_payload(face)).json()
    c = tc.post("/api/jobs", json=_composite_payload(face, [p1])).json()
    assert h["kind"] == "host"
    assert c["kind"] == "composite"
    assert h["id"] != c["id"]
    assert h["input_hash"] != c["input_hash"]


# ── GET /api/jobs/:id (step 5) ────────────────────────────────────────

def test_get_job_returns_owner_snapshot(client):
    tc, uploads = client
    face = _seed_image(uploads)
    created = tc.post("/api/jobs", json=_host_payload(face)).json()
    r = tc.get(f"/api/jobs/{created['id']}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == created["id"]
    assert body["state"] == "pending"
    assert body["kind"] == "host"
    # input_blob never leaks to the API client — eng-spec §8.
    assert "input_blob" not in body


def test_get_job_nonexistent_returns_404(client):
    tc, _ = client
    r = tc.get("/api/jobs/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404


def test_get_job_other_user_returns_404(client, monkeypatch):
    """A job belonging to user A is invisible to user B — even the 'exists'
    bit is not leaked (eng-spec §8). Both unknown-id and wrong-owner cases
    fold into 404."""
    tc, uploads = client
    face = _seed_image(uploads)
    a = tc.post("/api/jobs", json=_host_payload(face)).json()

    other = {
        "user_id": "otheruser", "display_name": "Other",
        "role": "member", "is_active": True,
        "approval_status": "approved",
        "subscriptions": ["platform", "studio"],
        "studio_token_version": 0, "hashed_password": "",
    }

    async def _bypass_other(req, call_next):
        req.state.user = dict(other)
        return await call_next(req)

    monkeypatch.setattr("modules.auth.auth_middleware", _bypass_other)
    r = tc.get(f"/api/jobs/{a['id']}")
    assert r.status_code == 404


def test_get_job_reflects_state_transition(client):
    """The snapshot endpoint reads live DB state — a transition driven by
    repo writes (e.g., the runner marking failed) shows up immediately."""
    tc, uploads = client
    face = _seed_image(uploads)
    created = tc.post("/api/jobs", json=_host_payload(face)).json()

    # Drive the row to ready directly with sync pymongo. The runner is
    # stubbed in this fixture so it wouldn't naturally advance the row;
    # we just need a different state in the DB to assert the GET endpoint
    # reads it back.
    import config
    from pymongo import MongoClient

    sync = MongoClient(config.MONGO_URL, serverSelectionTimeoutMS=2000)
    sync[config.DB_NAME].generation_jobs.update_one(
        {"_id": created["id"]},
        {"$set": {
            "state": "ready",
            "batch_id": "b1",
            "variants": [{"image_id": "v1"}],
        }},
    )
    sync.close()

    r = tc.get(f"/api/jobs/{created['id']}")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "ready"
    assert body["batch_id"] == "b1"
    assert [v["image_id"] for v in body["variants"]] == ["v1"]


# ── SSE GET /api/jobs/:id/events (step 7) ─────────────────────────────

def _set_db_state(job_id: str, **fields) -> None:
    import config
    from pymongo import MongoClient
    sync = MongoClient(config.MONGO_URL, serverSelectionTimeoutMS=2000)
    sync[config.DB_NAME].generation_jobs.update_one(
        {"_id": job_id}, {"$set": fields},
    )
    sync.close()


def _parse_sse_frames(body: str) -> list[dict]:
    """Parse SSE wire format into a list of {id, event, data} dicts.

    Frames are separated by blank lines. Each frame's lines are
    `<field>: <value>` with id/event/data being the fields we care
    about."""
    frames: list[dict] = []
    for raw in body.split("\n\n"):
        if not raw.strip():
            continue
        frame: dict = {}
        for line in raw.splitlines():
            if ": " in line:
                k, v = line.split(": ", 1)
                frame[k] = v
        if frame:
            frames.append(frame)
    return frames


def test_sse_terminal_state_emits_snapshot_and_closes(client):
    """A snap that's already in a terminal state means there's nothing to
    drain — the endpoint emits the snapshot frame and closes the stream
    so the client doesn't hang waiting for events that will never come."""
    tc, uploads = client
    face = _seed_image(uploads)
    created = tc.post("/api/jobs", json=_host_payload(face)).json()
    _set_db_state(
        created["id"],
        state="ready",
        batch_id="b1",
        variants=[{"image_id": "v1"}, {"image_id": "v2"}],
    )

    r = tc.get(f"/api/jobs/{created['id']}/events")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    assert r.headers["cache-control"] == "no-cache"
    assert r.headers["x-accel-buffering"] == "no"

    frames = _parse_sse_frames(r.text)
    assert len(frames) == 1
    assert frames[0]["event"] == "snapshot"
    snap = json.loads(frames[0]["data"])
    assert snap["state"] == "ready"
    assert snap["batch_id"] == "b1"
    assert [v["image_id"] for v in snap["variants"]] == ["v1", "v2"]
    # input_blob never leaks into the SSE wire either.
    assert "input_blob" not in snap


def test_sse_owner_scope_returns_404(client, monkeypatch):
    tc, uploads = client
    face = _seed_image(uploads)
    a = tc.post("/api/jobs", json=_host_payload(face)).json()

    other = {
        "user_id": "otheruser", "display_name": "Other",
        "role": "member", "is_active": True,
        "approval_status": "approved",
        "subscriptions": ["platform", "studio"],
        "studio_token_version": 0, "hashed_password": "",
    }

    async def _bypass_other(req, call_next):
        req.state.user = dict(other)
        return await call_next(req)

    monkeypatch.setattr("modules.auth.auth_middleware", _bypass_other)
    r = tc.get(f"/api/jobs/{a['id']}/events")
    assert r.status_code == 404


def test_sse_nonexistent_returns_404(client):
    tc, _ = client
    r = tc.get("/api/jobs/00000000-0000-0000-0000-000000000000/events")
    assert r.status_code == 404


def test_sse_cap_exceeded_returns_429(client, monkeypatch):
    """Simulate the cap by stubbing is_user_at_cap → True. The endpoint
    must reject before it returns the StreamingResponse (status code is
    locked once the body starts streaming)."""
    tc, uploads = client
    face = _seed_image(uploads)
    created = tc.post("/api/jobs", json=_host_payload(face)).json()

    monkeypatch.setattr(
        "modules.jobs_pubsub.jobs_pubsub.is_user_at_cap",
        lambda uid: True,
    )
    r = tc.get(f"/api/jobs/{created['id']}/events")
    assert r.status_code == 429
    assert "too many" in r.text.lower()


def test_sse_last_event_id_skips_snapshot_when_caught_up(client):
    """Client claims they have everything up to seq=999 via Last-Event-ID.
    Since seq_at_subscribe is 0 (no publishes have happened in this test),
    after_seq >= seq_at_subscribe → skip the snapshot. Stream closes
    immediately because the snap is in a terminal state."""
    tc, uploads = client
    face = _seed_image(uploads)
    created = tc.post("/api/jobs", json=_host_payload(face)).json()
    _set_db_state(created["id"], state="ready", batch_id="b1")

    r = tc.get(
        f"/api/jobs/{created['id']}/events",
        headers={"Last-Event-ID": "999"},
    )
    assert r.status_code == 200
    frames = _parse_sse_frames(r.text)
    # No snapshot frame emitted — client is "ahead" of seq_at_subscribe.
    assert frames == []


def test_sse_snapshot_seq_id_present(client):
    """The snapshot frame carries an `id:` line equal to seq_at_subscribe.
    Even with no events yet, the frame must be tagged so the client can
    set Last-Event-ID for a future reconnect."""
    tc, uploads = client
    face = _seed_image(uploads)
    created = tc.post("/api/jobs", json=_host_payload(face)).json()
    _set_db_state(created["id"], state="ready", batch_id="b1")

    r = tc.get(f"/api/jobs/{created['id']}/events")
    frames = _parse_sse_frames(r.text)
    assert len(frames) == 1
    assert "id" in frames[0]
    # seq_at_subscribe is 0 since no publishes have happened in this test;
    # the wire id is the literal "0".
    assert frames[0]["id"] == "0"


# ── DELETE /api/jobs/:id (step 8) ─────────────────────────────────────

def test_delete_pending_job_returns_cancelled_snapshot(client):
    tc, uploads = client
    face = _seed_image(uploads)
    created = tc.post("/api/jobs", json=_host_payload(face)).json()
    assert created["state"] == "pending"

    r = tc.delete(f"/api/jobs/{created['id']}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == created["id"]
    assert body["state"] == "cancelled"


def test_delete_streaming_job_succeeds(client):
    tc, uploads = client
    face = _seed_image(uploads)
    created = tc.post("/api/jobs", json=_host_payload(face)).json()
    _set_db_state(created["id"], state="streaming")

    r = tc.delete(f"/api/jobs/{created['id']}")
    assert r.status_code == 200
    assert r.json()["state"] == "cancelled"


def test_delete_already_terminal_returns_409(client):
    tc, uploads = client
    face = _seed_image(uploads)
    created = tc.post("/api/jobs", json=_host_payload(face)).json()
    _set_db_state(created["id"], state="ready", batch_id="b1")

    r = tc.delete(f"/api/jobs/{created['id']}")
    assert r.status_code == 409
    assert "already" in r.text.lower()


def test_delete_already_cancelled_returns_409(client):
    """Idempotent cancel is NOT supported — a second cancel is 409.
    eng-spec §8: DELETE returns 409 (already terminal) on a row that has
    moved out of {pending, streaming}."""
    tc, uploads = client
    face = _seed_image(uploads)
    created = tc.post("/api/jobs", json=_host_payload(face)).json()
    assert tc.delete(f"/api/jobs/{created['id']}").status_code == 200
    r = tc.delete(f"/api/jobs/{created['id']}")
    assert r.status_code == 409


def test_delete_other_user_returns_404(client, monkeypatch):
    """Owner mismatch must not leak existence — both not-found and
    not-owner fold into 404."""
    tc, uploads = client
    face = _seed_image(uploads)
    a = tc.post("/api/jobs", json=_host_payload(face)).json()

    other = {
        "user_id": "otheruser", "display_name": "Other",
        "role": "member", "is_active": True,
        "approval_status": "approved",
        "subscriptions": ["platform", "studio"],
        "studio_token_version": 0, "hashed_password": "",
    }

    async def _bypass_other(req, call_next):
        req.state.user = dict(other)
        return await call_next(req)

    monkeypatch.setattr("modules.auth.auth_middleware", _bypass_other)
    r = tc.delete(f"/api/jobs/{a['id']}")
    assert r.status_code == 404


def test_delete_nonexistent_returns_404(client):
    tc, _ = client
    r = tc.delete("/api/jobs/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404


def test_delete_publishes_cancelled_event(client, monkeypatch):
    """SSE subscribers must be told their stream is over. The endpoint
    publishes a 'cancelled' event after mark_cancelled succeeds."""
    tc, uploads = client
    face = _seed_image(uploads)
    created = tc.post("/api/jobs", json=_host_payload(face)).json()

    captured: list[tuple[str, dict]] = []
    real_publish = None

    async def _record(job_id: str, payload: dict) -> None:
        captured.append((job_id, payload))
        # Still call the real one so internal seq advances correctly.
        if real_publish is not None:
            await real_publish(job_id, payload)

    from modules.jobs_pubsub import jobs_pubsub
    real_publish = jobs_pubsub.publish
    monkeypatch.setattr(jobs_pubsub, "publish", _record)

    r = tc.delete(f"/api/jobs/{created['id']}")
    assert r.status_code == 200
    types = [evt["type"] for jid, evt in captured if jid == created["id"]]
    assert "cancelled" in types


def test_delete_then_sse_emits_cancelled_state(client):
    """A subscriber connecting AFTER the delete sees state=cancelled in
    the snapshot and the stream closes immediately (terminal-state path)."""
    tc, uploads = client
    face = _seed_image(uploads)
    created = tc.post("/api/jobs", json=_host_payload(face)).json()
    assert tc.delete(f"/api/jobs/{created['id']}").status_code == 200

    r = tc.get(f"/api/jobs/{created['id']}/events")
    assert r.status_code == 200
    frames = _parse_sse_frames(r.text)
    assert len(frames) == 1
    snap = json.loads(frames[0]["data"])
    assert snap["state"] == "cancelled"


# ── GET /api/jobs cursor pagination (step 9) ──────────────────────────

def test_list_empty(client):
    tc, _ = client
    r = tc.get("/api/jobs")
    assert r.status_code == 200
    assert r.json() == {"items": [], "next_cursor": None}


def test_list_returns_user_jobs_newest_first(client):
    tc, uploads = client
    face = _seed_image(uploads)
    ids = []
    for i in range(3):
        body = _host_payload(face, seeds=[i, i + 1, i + 2, i + 3])
        ids.append(tc.post("/api/jobs", json=body).json()["id"])
        # Tiny gap so created_at orders deterministically.
        import time
        time.sleep(0.005)

    r = tc.get("/api/jobs")
    assert r.status_code == 200
    items = r.json()["items"]
    assert [it["id"] for it in items] == list(reversed(ids))


def test_list_kind_filter(client):
    tc, uploads = client
    face = _seed_image(uploads, "face.png")
    p1 = _seed_image(uploads, "p1.png")
    h = tc.post("/api/jobs", json=_host_payload(face)).json()
    c = tc.post("/api/jobs", json=_composite_payload(face, [p1])).json()

    only_host = tc.get("/api/jobs?kind=host").json()
    assert {it["id"] for it in only_host["items"]} == {h["id"]}

    only_comp = tc.get("/api/jobs?kind=composite").json()
    assert {it["id"] for it in only_comp["items"]} == {c["id"]}


def test_list_state_filter(client):
    tc, uploads = client
    face = _seed_image(uploads)
    a = tc.post("/api/jobs", json=_host_payload(face, seeds=[1])).json()
    b = tc.post("/api/jobs", json=_host_payload(face, seeds=[2])).json()
    _set_db_state(a["id"], state="ready", batch_id="b1")
    # b stays pending.

    only_ready = tc.get("/api/jobs?state=ready").json()
    assert {it["id"] for it in only_ready["items"]} == {a["id"]}

    only_pending = tc.get("/api/jobs?state=pending").json()
    assert {it["id"] for it in only_pending["items"]} == {b["id"]}


def test_list_pagination(client):
    tc, uploads = client
    face = _seed_image(uploads)
    ids = []
    for i in range(5):
        ids.append(tc.post(
            "/api/jobs", json=_host_payload(face, seeds=[i, i, i, i]),
        ).json()["id"])
        import time
        time.sleep(0.005)

    p1 = tc.get("/api/jobs?limit=2").json()
    assert len(p1["items"]) == 2
    assert p1["next_cursor"] is not None

    p2 = tc.get(f"/api/jobs?limit=2&cursor={p1['next_cursor']}").json()
    assert len(p2["items"]) == 2
    assert p2["next_cursor"] is not None

    p3 = tc.get(f"/api/jobs?limit=2&cursor={p2['next_cursor']}").json()
    assert len(p3["items"]) == 1
    assert p3["next_cursor"] is None

    seen = {it["id"] for p in (p1, p2, p3) for it in p["items"]}
    assert seen == set(ids)


def test_list_owner_scope(client, monkeypatch):
    """user A's jobs are invisible to user B even when B passes A's
    cursor (the repo's owner-scoped cursor lookup folds into a head reset
    for B's view, exposing only B's rows)."""
    tc, uploads = client
    face = _seed_image(uploads)
    a_job = tc.post("/api/jobs", json=_host_payload(face)).json()

    other = {
        "user_id": "otheruser", "display_name": "Other",
        "role": "member", "is_active": True,
        "approval_status": "approved",
        "subscriptions": ["platform", "studio"],
        "studio_token_version": 0, "hashed_password": "",
    }

    async def _bypass_other(req, call_next):
        req.state.user = dict(other)
        return await call_next(req)

    monkeypatch.setattr("modules.auth.auth_middleware", _bypass_other)
    # B's listing is empty, even though A has a job.
    other_list = tc.get("/api/jobs").json()
    assert other_list["items"] == []
    # Even passing A's job_id as cursor (not B's) doesn't leak A's rows —
    # cursor lookup is owner-scoped, stale cursor folds into head reset.
    other_with_cursor = tc.get(f"/api/jobs?cursor={a_job['id']}").json()
    assert other_with_cursor["items"] == []


def test_list_invalid_kind_returns_400(client):
    tc, _ = client
    r = tc.get("/api/jobs?kind=weird")
    assert r.status_code == 400
    assert "kind" in r.text.lower()


def test_list_invalid_state_returns_400(client):
    tc, _ = client
    r = tc.get("/api/jobs?state=garbage")
    assert r.status_code == 400


def test_list_limit_clamped_by_repo(client):
    """Very large limits clamp at 50, very small at 1. The endpoint
    inherits this from the repo — eng-spec §8 default 20, max 50."""
    tc, uploads = client
    face = _seed_image(uploads)
    for i in range(3):
        tc.post("/api/jobs", json=_host_payload(face, seeds=[i, i, i, i]))

    huge = tc.get("/api/jobs?limit=10000").json()
    assert len(huge["items"]) == 3  # only 3 exist; cap not stressed

    tiny = tc.get("/api/jobs?limit=0").json()
    # Repo clamps to 1 minimum.
    assert len(tiny["items"]) == 1


def test_list_includes_cancelled_jobs(client):
    """Integration check with step 8: a cancelled row appears in listings
    under state=cancelled, and not under state=pending."""
    tc, uploads = client
    face = _seed_image(uploads)
    j = tc.post("/api/jobs", json=_host_payload(face)).json()
    assert tc.delete(f"/api/jobs/{j['id']}").status_code == 200

    pending = tc.get("/api/jobs?state=pending").json()
    assert pending["items"] == []

    cancelled = tc.get("/api/jobs?state=cancelled").json()
    assert {it["id"] for it in cancelled["items"]} == {j["id"]}


def test_list_does_not_leak_input_blob(client):
    tc, uploads = client
    face = _seed_image(uploads)
    tc.post("/api/jobs", json=_host_payload(face))
    listing = tc.get("/api/jobs").json()
    assert all("input_blob" not in it for it in listing["items"])
