"""Phase 1 — /api/hosts CRUD endpoint tests (FastAPI TestClient)."""
from __future__ import annotations

from pathlib import Path

import pytest

pytestmark = pytest.mark.phase1


@pytest.fixture
def client(monkeypatch, tmp_path):
    """Isolated TestClient with HOSTS_DIR/UPLOADS_DIR redirected to tmp_path."""
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    hosts = outputs / "hosts" / "saved"
    examples = tmp_path / "examples"
    for d in (uploads, outputs, hosts, examples):
        d.mkdir(parents=True, exist_ok=True)

    # Patch config BEFORE app import so app picks up redirects
    import config

    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "HOSTS_DIR", str(hosts))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(examples))
    monkeypatch.setattr(config, "SAFE_ROOTS", (str(uploads), str(outputs), str(examples)))

    from fastapi.testclient import TestClient
    import app as app_module

    return TestClient(app_module.app), uploads, hosts


def test_list_empty_hosts(client):
    tc, _, _ = client
    r = tc.get("/api/hosts")
    assert r.status_code == 200
    assert r.json() == {"hosts": []}


def test_save_and_list_and_delete_roundtrip(client):
    tc, uploads, hosts = client
    # Create a source image in UPLOADS
    from PIL import Image

    src = uploads / "cand.png"
    Image.new("RGB", (100, 150), "blue").save(src)

    # Save
    r = tc.post(
        "/api/hosts/save",
        data={"source_path": str(src), "name": "민지"},
    )
    assert r.status_code == 200, r.text
    saved = r.json()
    assert saved["name"] == "민지"
    assert "id" in saved
    host_id = saved["id"]

    # List contains the saved host
    r = tc.get("/api/hosts")
    assert r.status_code == 200
    data = r.json()
    assert len(data["hosts"]) == 1
    assert data["hosts"][0]["name"] == "민지"

    # Delete
    r = tc.delete(f"/api/hosts/{host_id}")
    assert r.status_code == 200
    assert r.json()["id"] == host_id

    # List empty again
    r = tc.get("/api/hosts")
    assert r.json()["hosts"] == []


def test_delete_nonexistent_host_returns_404(client):
    tc, _, _ = client
    r = tc.delete("/api/hosts/abc123def456")  # valid alnum, doesn't exist
    assert r.status_code == 404


def test_delete_rejects_invalid_host_id(client):
    tc, _, _ = client
    # Path traversal attempt (dots not allowed in alnum check)
    r = tc.delete("/api/hosts/..evil")
    assert r.status_code == 400


def test_save_rejects_source_outside_safe_roots(client):
    tc, _, _ = client
    # /etc/passwd must be rejected by safe_upload_path
    r = tc.post(
        "/api/hosts/save",
        data={"source_path": "/etc/passwd", "name": "evil"},
    )
    assert r.status_code == 400


def test_save_rejects_nonexistent_source(client):
    tc, uploads, _ = client
    ghost = uploads / "ghost.png"
    r = tc.post(
        "/api/hosts/save",
        data={"source_path": str(ghost), "name": "x"},
    )
    assert r.status_code == 404
