"""DELETE /api/videos/{task_id} — S3 + LocalDisk parity (PR-0).

Pre-PR-0, the handler called media_store.local_path_for(storage_key) to
resolve the on-disk file before os.unlink. On S3 backend that raises
NotImplementedError, so DELETE returned 500 in production. PR-0 routes
the deletion through media_store.delete(), which is supported on both
backends, with best-effort local cleanup for in-flight worker temps and
legacy LocalDisk-only rows.

These tests pin the contract on both backends so a regression on either
side is caught.

Mongo row seeding goes through the synchronous pymongo client, not the
async repo, to avoid event-loop entanglement between FastAPI's TestClient
loop and the test's pytest-asyncio loop. The handler exercise still uses
the real async repo path internally.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pymongo import MongoClient


_USER_ID = "testuser"  # matches conftest._FAKE_USER


def _completed_doc(task_id: str, *, storage_key: str) -> dict:
    now = datetime.now(timezone.utc)
    return {
        "user_id": _USER_ID,
        "task_id": task_id,
        "type": "generate",
        "status": "completed",
        "video_storage_key": storage_key,
        "video_path": None,
        "params": {},
        "meta": {},
        "created_at": now,
        "completed_at": now,
    }


def _legacy_doc(task_id: str, *, video_path: str) -> dict:
    """Pre-C7 row: video_path absolute, no storage_key. status='error'
    so the post-C7 completed-invariant check (asserting video_storage_key)
    doesn't apply — this is exactly the kind of row that legacy fallback
    serves."""
    now = datetime.now(timezone.utc)
    return {
        "user_id": _USER_ID,
        "task_id": task_id,
        "type": "generate",
        "status": "error",
        "video_storage_key": None,
        "video_path": video_path,
        "params": {},
        "meta": {},
        "error": "legacy fixture",
        "created_at": now,
        "completed_at": now,
    }


@pytest.fixture
def client(monkeypatch, tmp_path):
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    examples = tmp_path / "examples"
    for d in (uploads, outputs, examples):
        d.mkdir(parents=True, exist_ok=True)

    import config

    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(examples))
    monkeypatch.setattr(config, "SAFE_ROOTS", (str(uploads), str(outputs), str(examples)))

    import app as app_module

    with TestClient(app_module.app) as test_client:
        test_client._outputs_dir = str(outputs)
        yield test_client


@pytest.fixture
def results_collection():
    """Sync pymongo handle to studio_results in the test DB. Yields the
    collection so tests can seed/inspect without touching the async repo
    (which gets entangled with TestClient's event loop)."""
    import config

    mc = MongoClient(config.MONGO_URL, serverSelectionTimeoutMS=2000)
    coll = mc[config.DB_NAME]["studio_results"]
    coll.delete_many({"user_id": _USER_ID})  # belt + suspenders, conftest also sweeps
    yield coll
    mc.close()


def test_localdisk_deletes_file_and_row(client, results_collection):
    """Default LocalDisk backend — storage_key resolves to a real file,
    media_store.delete unlinks it, Mongo row goes away."""
    outputs = Path(client._outputs_dir)
    mp4 = outputs / "delete-me.mp4"
    mp4.write_bytes(b"fake mp4")
    storage_key = f"outputs/{mp4.name}"

    task_id = "del-local-1"
    results_collection.insert_one(_completed_doc(task_id, storage_key=storage_key))

    r = client.delete(f"/api/videos/{task_id}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["video_deleted"] is True
    assert body["row_deleted"] is True
    assert not mp4.exists(), "file should be unlinked"
    assert results_collection.find_one({"user_id": _USER_ID, "task_id": task_id}) is None


def test_localdisk_legacy_video_path_only(client, results_collection):
    """Pre-C7 row: video_path absolute, no storage_key. Falls into the
    legacy local cleanup branch."""
    outputs = Path(client._outputs_dir)
    mp4 = outputs / "legacy.mp4"
    mp4.write_bytes(b"old mp4")

    task_id = "del-legacy-1"
    results_collection.insert_one(_legacy_doc(task_id, video_path=str(mp4)))

    r = client.delete(f"/api/videos/{task_id}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["video_deleted"] is True
    assert body["row_deleted"] is True
    assert not mp4.exists()


def test_404_when_nothing_exists(client):
    """No row, no in-flight state, no cascade — 404."""
    r = client.delete("/api/videos/missing-task-1")
    assert r.status_code == 404


def test_s3_backend_deletes_object_and_row(client, results_collection, s3_media_store_swap):
    """S3 backend (moto) — media_store.delete clears the bucket object;
    pre-PR-0 this path raised NotImplementedError via local_path_for."""
    storage_key = "outputs/s3-mp4.mp4"
    s3_media_store_swap.s3.put_object(
        Bucket=s3_media_store_swap._bucket,
        Key=s3_media_store_swap._full_key(storage_key),
        Body=b"fake s3 mp4",
    )
    assert s3_media_store_swap.exists(storage_key), "fixture: object should be present"

    task_id = "del-s3-1"
    results_collection.insert_one(_completed_doc(task_id, storage_key=storage_key))

    r = client.delete(f"/api/videos/{task_id}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["video_deleted"] is True, body
    assert body["row_deleted"] is True
    assert not s3_media_store_swap.exists(storage_key), "S3 object should be gone"


def test_s3_backend_object_already_gone(client, results_collection, s3_media_store_swap):
    """S3 backend — storage_key recorded but object already deleted (e.g.
    lifecycle cleanup ran first). delete() returns False; the handler still
    succeeds because the Mongo row was removed."""
    storage_key = "outputs/already-gone.mp4"
    assert not s3_media_store_swap.exists(storage_key)

    task_id = "del-s3-orphan"
    results_collection.insert_one(_completed_doc(task_id, storage_key=storage_key))

    r = client.delete(f"/api/videos/{task_id}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["video_deleted"] is False
    assert body["row_deleted"] is True
