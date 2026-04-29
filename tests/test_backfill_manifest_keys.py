"""Tests for scripts/backfill_manifest_keys.py

The script recovers studio_results rows where the worker shadowed the
original storage_key with a temp absolute path. Two recovery sources:
1. generation_jobs (the queue row's untouched params)
2. meta.composition.selectedPath / meta.host.selectedPath fallback

These tests stand up an isolated test DB, seed both collections, run
the script with --dry-run and live, and verify mutations.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from pymongo import MongoClient

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "backfill_manifest_keys.py"

_TEST_MONGO_URL = "mongodb://localhost:27017"


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}_backfill"


@pytest.fixture
def db():
    """Per-test isolated DB. Drops studio_results + generation_jobs on
    entry and exit so the script sees a clean slate."""
    client = MongoClient(_TEST_MONGO_URL, serverSelectionTimeoutMS=2000)
    name = _test_db_name()
    db = client[name]
    db["studio_results"].drop()
    db["generation_jobs"].drop()
    yield db
    db["studio_results"].drop()
    db["generation_jobs"].drop()
    client.close()


def _run_script(*args: str, mongo_url: str, db_name: str) -> subprocess.CompletedProcess:
    """Execute the backfill script as a subprocess with explicit env."""
    env = {
        **os.environ,
        "MONGO_URL": mongo_url,
        "DB_NAME": db_name,
    }
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def _temp_path(name: str) -> str:
    return f"/opt/home/jack/workspace/SoulX-FlashTalk/temp/{name}"


# ── recovery from generation_jobs ────────────────────────────────


def test_recovers_host_and_audio_from_generation_jobs(db):
    """When generation_jobs has the original storage_keys, both host_image
    and audio_path get fully restored."""
    db["studio_results"].insert_one({
        "task_id": "task_full_recovery",
        "user_id": "u",
        "status": "completed",
        "params": {
            "host_image": _temp_path("job-input-h.png"),
            "audio_path": _temp_path("job-input-a.wav"),
            "reference_image_paths": [],
        },
        "meta": {},
    })
    db["generation_jobs"].insert_one({
        "task_id": "task_full_recovery",
        "user_id": "u",
        "status": "completed",
        "params": {
            "host_image": "outputs/composites/comp_recovered.png",
            "audio_path": "outputs/tts_recovered.wav",
        },
    })

    res = _run_script(
        mongo_url=_TEST_MONGO_URL,
        db_name=_test_db_name(),
    )
    assert res.returncode == 0, res.stderr

    row = db["studio_results"].find_one({"task_id": "task_full_recovery"})
    assert row["params"]["host_image"] == "outputs/composites/comp_recovered.png"
    assert row["params"]["audio_path"] == "outputs/tts_recovered.wav"


# ── recovery without generation_jobs ─────────────────────────────


def test_recovers_host_from_meta_composition_when_queue_pruned(db):
    """generation_jobs has been pruned (FIFO MAX_FINISHED rotation) but
    meta.composition.selectedPath still has the canonical composite key."""
    db["studio_results"].insert_one({
        "task_id": "task_meta_only",
        "user_id": "u",
        "status": "completed",
        "params": {
            "host_image": _temp_path("job-input-h.png"),
            "audio_path": _temp_path("job-input-a.wav"),
            "reference_image_paths": [],
        },
        "meta": {
            "composition": {
                "selectedPath": "outputs/composites/comp_meta.png",
            },
            "host": {
                "selectedPath": "outputs/hosts/saved/host_meta.png",
            },
        },
    })

    res = _run_script(
        mongo_url=_TEST_MONGO_URL,
        db_name=_test_db_name(),
    )
    assert res.returncode == 0, res.stderr

    row = db["studio_results"].find_one({"task_id": "task_meta_only"})
    # Composite wins over host — that's the actual frame FlashTalk used.
    assert row["params"]["host_image"] == "outputs/composites/comp_meta.png"
    # No queue row → audio is permanently lost, must be None.
    assert row["params"]["audio_path"] is None


def test_falls_back_to_meta_host_when_no_composition(db):
    db["studio_results"].insert_one({
        "task_id": "task_host_only",
        "user_id": "u",
        "status": "completed",
        "params": {
            "host_image": _temp_path("job-input-h.png"),
            "audio_path": _temp_path("job-input-a.wav"),
            "reference_image_paths": [],
        },
        "meta": {
            "host": {"selectedPath": "outputs/hosts/saved/host_alone.png"},
        },
    })

    res = _run_script(
        mongo_url=_TEST_MONGO_URL,
        db_name=_test_db_name(),
    )
    assert res.returncode == 0, res.stderr

    row = db["studio_results"].find_one({"task_id": "task_host_only"})
    assert row["params"]["host_image"] == "outputs/hosts/saved/host_alone.png"


# ── dry-run does not mutate ──────────────────────────────────────


def test_dry_run_makes_no_writes(db):
    db["studio_results"].insert_one({
        "task_id": "task_dry",
        "user_id": "u",
        "status": "completed",
        "params": {
            "host_image": _temp_path("job-input-h.png"),
            "audio_path": _temp_path("job-input-a.wav"),
            "reference_image_paths": [],
        },
        "meta": {
            "composition": {"selectedPath": "outputs/composites/comp_x.png"},
        },
    })

    res = _run_script(
        "--dry-run",
        mongo_url=_TEST_MONGO_URL,
        db_name=_test_db_name(),
    )
    assert res.returncode == 0, res.stderr
    assert "(dry-run)" in res.stdout

    row = db["studio_results"].find_one({"task_id": "task_dry"})
    # Untouched.
    assert row["params"]["host_image"] == _temp_path("job-input-h.png")
    assert row["params"]["audio_path"] == _temp_path("job-input-a.wav")


# ── idempotency ──────────────────────────────────────────────────


def test_idempotent_second_run_is_noop(db):
    db["studio_results"].insert_one({
        "task_id": "task_idem",
        "user_id": "u",
        "status": "completed",
        "params": {
            "host_image": _temp_path("job-input-h.png"),
            "audio_path": _temp_path("job-input-a.wav"),
            "reference_image_paths": [],
        },
        "meta": {
            "composition": {"selectedPath": "outputs/composites/comp_idem.png"},
        },
    })

    # First run.
    _run_script(mongo_url=_TEST_MONGO_URL, db_name=_test_db_name())
    row1 = db["studio_results"].find_one({"task_id": "task_idem"})

    # Second run — should not match the candidates regex now.
    res2 = _run_script(mongo_url=_TEST_MONGO_URL, db_name=_test_db_name())
    assert res2.returncode == 0
    assert "candidates: 0" in res2.stdout

    row2 = db["studio_results"].find_one({"task_id": "task_idem"})
    assert row1["params"] == row2["params"]


# ── ref_paths cleanup ────────────────────────────────────────────


def test_reference_image_paths_recovered_from_queue(db):
    db["studio_results"].insert_one({
        "task_id": "task_refs",
        "user_id": "u",
        "status": "completed",
        "params": {
            "host_image": "outputs/composites/comp_ok.png",
            "audio_path": "outputs/audio_ok.wav",
            "reference_image_paths": [
                _temp_path("job-input-r1.png"),
                _temp_path("job-input-r2.png"),
            ],
        },
        "meta": {},
    })
    db["generation_jobs"].insert_one({
        "task_id": "task_refs",
        "user_id": "u",
        "status": "completed",
        "params": {
            "host_image": "outputs/composites/comp_ok.png",
            "audio_path": "outputs/audio_ok.wav",
            "reference_image_paths": [
                "uploads/ref_1.png",
                "uploads/ref_2.png",
            ],
        },
    })

    res = _run_script(
        mongo_url=_TEST_MONGO_URL,
        db_name=_test_db_name(),
    )
    assert res.returncode == 0, res.stderr

    row = db["studio_results"].find_one({"task_id": "task_refs"})
    assert row["params"]["reference_image_paths"] == [
        "uploads/ref_1.png",
        "uploads/ref_2.png",
    ]
