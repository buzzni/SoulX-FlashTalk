"""Tests for POST /api/jobs (kind='host') — eng-spec §8 + §6.5 dedupe."""
from __future__ import annotations

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
