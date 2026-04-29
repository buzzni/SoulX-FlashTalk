"""Phase 1 — POST /api/host/generate endpoint tests."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

pytestmark = pytest.mark.phase1


@pytest.fixture
def client(monkeypatch, tmp_path):
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    hosts = outputs / "hosts" / "saved"
    examples = tmp_path / "examples"
    for d in (uploads, outputs, hosts, examples):
        d.mkdir(parents=True, exist_ok=True)

    import config

    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "HOSTS_DIR", str(hosts))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(examples))
    monkeypatch.setattr(config, "SAFE_ROOTS", (str(uploads), str(outputs), str(examples)))

    from fastapi.testclient import TestClient
    import app as app_module

    with TestClient(app_module.app) as c:
        yield c


def test_happy_path_returns_candidates(client, tmp_path):
    """Mock Gemini; verify endpoint returns proper payload shape.

    PR S3+ C6a: the endpoint now uploads each candidate's local PNG
    into media_store, so the mock has to point at real files on disk
    (was a fake `/x/host_s*.png` before). Fixture's HOSTS_DIR is
    `tmp_path/outputs/hosts/saved`, so we drop a 1-byte PNG-ish
    placeholder there for each seed."""
    import config
    hosts_dir = config.HOSTS_DIR
    paths = []
    for seed in (10, 42, 77, 128):
        p = f"{hosts_dir}/host_s{seed}.png"
        with open(p, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n")  # minimal PNG magic — enough for shutil.copyfile
        paths.append(p)

    fake_result = {
        "candidates": [
            {"seed": s, "path": p, "url": f"/api/files/{p}"}
            for s, p in zip((10, 42, 77, 128), paths)
        ],
        "partial": False,
        "errors": None,
    }
    with patch(
        "modules.host_generator.generate_host_candidates",
        new=AsyncMock(return_value=fake_result),
    ):
        r = client.post(
            "/api/host/generate",
            data={"mode": "text", "prompt": "30대 여성 쇼호스트, 친근함"},
        )
    assert r.status_code == 200, r.text
    data = r.json()
    assert len(data["candidates"]) == 4
    assert data["partial"] is False
    # PR S3+ C6a: each candidate now carries storage_key + url
    for cand in data["candidates"]:
        assert cand["storage_key"].startswith("outputs/hosts/saved/host_s")
        assert cand["url"].startswith("/api/files/outputs/hosts/saved/")


def test_invalid_mode_returns_400(client):
    """ValueError from generator → 400."""
    r = client.post(
        "/api/host/generate",
        data={"mode": "invalid"},
    )
    assert r.status_code == 400


def test_missing_prompt_for_text_mode_returns_400(client):
    r = client.post(
        "/api/host/generate",
        data={"mode": "text"},  # no prompt
    )
    assert r.status_code == 400


def test_all_generation_fails_returns_503(client):
    """RuntimeError from generator (all Gemini calls failed) → 503."""
    async def boom(*args, **kwargs):
        raise RuntimeError("Only 0/4 candidates succeeded")

    with patch("modules.host_generator.generate_host_candidates", new=AsyncMock(side_effect=boom)):
        r = client.post(
            "/api/host/generate",
            data={"mode": "text", "prompt": "여성 쇼호스트 30대"},
        )
    assert r.status_code == 503


def test_face_ref_path_traversal_rejected(client):
    """Body-field path-traversal rejected via safe_upload_path (Critical #2)."""
    r = client.post(
        "/api/host/generate",
        data={
            "mode": "face-outfit",
            "faceRefPath": "/etc/passwd",
            "outfitRefPath": "/etc/shadow",
        },
    )
    assert r.status_code == 400


def test_invalid_builder_json_returns_400(client):
    r = client.post(
        "/api/host/generate",
        data={"mode": "text", "prompt": "여성 쇼호스트 30대", "builder": "not-json"},
    )
    assert r.status_code == 400


def test_builder_must_be_object(client):
    r = client.post(
        "/api/host/generate",
        data={"mode": "text", "prompt": "여성 쇼호스트 30대", "builder": "[1,2]"},
    )
    assert r.status_code == 400
