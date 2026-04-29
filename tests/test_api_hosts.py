"""Phase 1 — /api/hosts CRUD endpoint tests (FastAPI TestClient).

Eng-review 2026-04-29 (codex tension 1±, 5±) reshaped this suite:
- save_host now takes `source_image_id` (a row in studio_hosts owned by
  the requesting user) instead of an arbitrary `source_path`. Tests
  pre-populate studio_hosts via sync pymongo (TestClient owns its own
  asyncio loop, so motor calls from the test thread fail with "task
  attached to a different loop").
- delete is soft, not hard. Tests assert the row vanishes from list
  but the file stays on disk.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

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

    import config

    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "HOSTS_DIR", str(hosts))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(examples))
    monkeypatch.setattr(config, "SAFE_ROOTS", (str(uploads), str(outputs), str(examples)))

    from fastapi.testclient import TestClient
    import app as app_module

    with TestClient(app_module.app) as tc:
        yield tc, uploads, hosts


def _seed_candidate(
    user_id: str,
    image_id: str,
    *,
    storage_key: str,
    extra: Optional[dict] = None,
) -> None:
    """Drop a row directly into studio_hosts so save_host can find it.

    Uses sync pymongo (not motor) because the TestClient owns its own
    asyncio loop. save_host's owner-scoped lookup is the gate we want
    to exercise; pre-populating studio_hosts is the cleanest way to
    hit it from a TestClient (going through the host generate stream
    would require a real Gemini key).
    """
    from pymongo import MongoClient
    import config
    cli = MongoClient(config.MONGO_URL, serverSelectionTimeoutMS=2000)
    db = cli[config.DB_NAME]
    doc = {
        "user_id": user_id,
        "image_id": image_id,
        "step": "1-host",
        "storage_key": storage_key,
        "status": "draft",
        "batch_id": "batch_test",
        "is_prev_selected": False,
        "generated_at": datetime.now(timezone.utc),
        "video_ids": [],
    }
    if extra:
        doc.update(extra)
    db.studio_hosts.update_one(
        {"user_id": user_id, "image_id": image_id},
        {"$set": doc},
        upsert=True,
    )
    cli.close()


def _png_at(path: Path) -> None:
    from PIL import Image
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (100, 150), "blue").save(path)


# ───────────────────────── happy path ─────────────────────────


def test_list_empty_hosts(client):
    tc, _, _ = client
    r = tc.get("/api/hosts")
    assert r.status_code == 200
    assert r.json() == {"hosts": []}


def test_save_returns_typed_saved_host(client):
    """save_host returns SavedHost shape (id, name, key, url, created_at,
    face_ref_for_variation, …) — typed via response_model=SavedHost.
    """
    tc, _, hosts = client
    candidate_path = hosts / "host_abc12345_s42.png"
    _png_at(candidate_path)
    candidate_key = "outputs/hosts/saved/host_abc12345_s42.png"
    _seed_candidate("testuser", "host_abc12345_s42", storage_key=candidate_key)

    r = tc.post(
        "/api/hosts/save",
        data={"source_image_id": "host_abc12345_s42", "name": "민지"},
    )
    assert r.status_code == 200, r.text
    saved = r.json()
    assert saved["name"] == "민지"
    assert "id" in saved and saved["id"] != "host_abc12345_s42"  # fresh uuid
    assert saved["key"].startswith("outputs/hosts/saved/")
    assert saved["url"]
    assert saved["created_at"]
    # face_ref_for_variation falls back to key when meta has no clean anchor
    assert saved["face_ref_for_variation"] == saved["key"]
    # selected_seed parsed from image_id suffix
    assert saved["meta"]["selected_seed"] == 42


def test_save_and_list_and_soft_delete_roundtrip(client):
    tc, _, hosts = client
    candidate_path = hosts / "host_abc12345_s7.png"
    _png_at(candidate_path)
    candidate_key = "outputs/hosts/saved/host_abc12345_s7.png"
    _seed_candidate("testuser", "host_abc12345_s7", storage_key=candidate_key)

    r = tc.post(
        "/api/hosts/save",
        data={"source_image_id": "host_abc12345_s7", "name": "주연"},
    )
    assert r.status_code == 200, r.text
    saved = r.json()
    host_id = saved["id"]
    saved_file = candidate_path.parent / f"{host_id}.png"
    assert saved_file.exists()  # file copied to a fresh saved-host key

    r = tc.get("/api/hosts")
    assert r.status_code == 200
    hosts_list = r.json()["hosts"]
    assert len(hosts_list) == 1
    assert hosts_list[0]["name"] == "주연"

    r = tc.delete(f"/api/hosts/{host_id}")
    assert r.status_code == 200
    assert r.json()["id"] == host_id

    # Soft-delete: file STAYS on disk (cron GCs later), list hides the row.
    assert saved_file.exists(), "soft-delete must keep the file"
    r = tc.get("/api/hosts")
    assert r.json()["hosts"] == []


# ───────────────────────── ownership ─────────────────────────


def test_save_cross_user_source_image_id_returns_404(client):
    """codex T1±: user A may not save a candidate that belongs to user B.

    studio_host_repo.find_by_image_id is user_id-scoped — sending B's
    image_id while authenticated as A returns None, which save_host
    surfaces as 404. No leak of the existence of B's image_id.
    """
    tc, _, hosts = client
    other_user_path = hosts / "host_otheruser_s1.png"
    _png_at(other_user_path)
    _seed_candidate("alice", "host_otheruser_s1",
                    storage_key="outputs/hosts/saved/host_otheruser_s1.png")

    # The TestClient runs as `testuser` (conftest._FAKE_USER), not alice.
    r = tc.post(
        "/api/hosts/save",
        data={"source_image_id": "host_otheruser_s1", "name": "hijack"},
    )
    assert r.status_code == 404


def test_save_unknown_source_image_id_returns_404(client):
    tc, _, _ = client
    r = tc.post(
        "/api/hosts/save",
        data={"source_image_id": "host_doesnotexist_s0", "name": "x"},
    )
    assert r.status_code == 404


# ───────────────────────── input validation ─────────────────────────


def test_save_rejects_traversal_shaped_image_id(client):
    tc, _, _ = client
    r = tc.post(
        "/api/hosts/save",
        data={"source_image_id": "..evil/x", "name": "x"},
    )
    # Form min/max bounds may catch length first; either 400 or 422 is fine.
    assert r.status_code in (400, 422), r.text


def test_save_rejects_blank_name_after_strip(client):
    """Form min_length=1 lets `"   "` through; endpoint strips and re-checks."""
    tc, _, hosts = client
    candidate_path = hosts / "host_a_s1.png"
    _png_at(candidate_path)
    _seed_candidate("testuser", "host_a_s1",
                    storage_key="outputs/hosts/saved/host_a_s1.png")
    r = tc.post(
        "/api/hosts/save",
        data={"source_image_id": "host_a_s1", "name": "   "},
    )
    assert r.status_code == 422


def test_save_rejects_empty_name(client):
    tc, _, _ = client
    r = tc.post(
        "/api/hosts/save",
        data={"source_image_id": "host_x_s0", "name": ""},
    )
    assert r.status_code == 422


def test_save_rejects_overlong_name(client):
    tc, _, _ = client
    r = tc.post(
        "/api/hosts/save",
        data={"source_image_id": "host_x_s0", "name": "x" * 101},
    )
    assert r.status_code == 422


def test_save_strips_whitespace_from_name(client):
    tc, _, hosts = client
    candidate_path = hosts / "host_b_s5.png"
    _png_at(candidate_path)
    _seed_candidate("testuser", "host_b_s5",
                    storage_key="outputs/hosts/saved/host_b_s5.png")
    r = tc.post(
        "/api/hosts/save",
        data={"source_image_id": "host_b_s5", "name": "  쇼호스트1  "},
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "쇼호스트1"


def test_save_ignores_client_supplied_meta(client):
    """codex T1±: meta is no longer a Form parameter at all — even if
    the client tries to send it, FastAPI ignores unknown fields and the
    server derives meta from studio_hosts.
    """
    tc, _, hosts = client
    candidate_path = hosts / "host_c_s9.png"
    _png_at(candidate_path)
    _seed_candidate("testuser", "host_c_s9",
                    storage_key="outputs/hosts/saved/host_c_s9.png")
    r = tc.post(
        "/api/hosts/save",
        data={
            "source_image_id": "host_c_s9",
            "name": "민지",
            # Smuggling attempt — must NOT land in saved meta.
            "meta": '{"face_ref_storage_key":"outputs/other-users-private.png"}',
        },
    )
    assert r.status_code == 200, r.text
    saved = r.json()
    # face_ref_for_variation falls back to the saved host's own key
    # (no client-controllable face anchor smuggling possible).
    assert saved["face_ref_for_variation"] == saved["key"]
    if saved.get("meta"):
        assert saved["meta"].get("face_ref_storage_key") is None


# ───────────────────────── delete ─────────────────────────


def test_delete_nonexistent_host_returns_404(client):
    tc, _, _ = client
    r = tc.delete("/api/hosts/abc123def456")
    assert r.status_code == 404


def test_delete_rejects_invalid_host_id(client):
    tc, _, _ = client
    r = tc.delete("/api/hosts/..evil")
    assert r.status_code == 400


def test_delete_already_deleted_returns_404(client):
    """Soft-delete is one-shot — second call hits no-live-row, returns 404."""
    tc, _, hosts = client
    candidate_path = hosts / "host_d_s3.png"
    _png_at(candidate_path)
    _seed_candidate("testuser", "host_d_s3",
                    storage_key="outputs/hosts/saved/host_d_s3.png")
    r = tc.post(
        "/api/hosts/save",
        data={"source_image_id": "host_d_s3", "name": "x"},
    )
    host_id = r.json()["id"]
    assert tc.delete(f"/api/hosts/{host_id}").status_code == 200
    assert tc.delete(f"/api/hosts/{host_id}").status_code == 404
