"""Tests for scripts.studio_006_add_subscriptions (dry-run, commit, idempotency)."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from pymongo import MongoClient


REPO_ROOT = Path(__file__).resolve().parent.parent


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}_mig006"


@pytest.fixture
def fresh_db():
    client = MongoClient("mongodb://localhost:27017", serverSelectionTimeoutMS=2000)
    db = client[_test_db_name()]
    for coll in db.list_collection_names():
        db[coll].drop()
    db.users.insert_many([
        {"user_id": "alice", "is_active": True, "approval_status": "approved"},
        {"user_id": "bob",   "is_active": True, "approval_status": "approved"},
        {"user_id": "carol", "is_active": True, "approval_status": "approved",
         "subscriptions": ["platform"], "studio_token_version": 7},
    ])
    yield db
    for coll in db.list_collection_names():
        db[coll].drop()
    client.close()


def _run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "studio_006_add_subscriptions.py"), *args],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
        env={**os.environ, "DB_NAME": _test_db_name(),
             "MONGO_URL": "mongodb://localhost:27017"},
    )


def test_dry_run_makes_no_writes(fresh_db):
    proc = _run(["--dry-run"])
    assert proc.returncode == 0, proc.stderr
    assert "DRY-RUN" in proc.stdout
    # No changes
    assert fresh_db.users.count_documents({"subscriptions": {"$exists": True}}) == 1  # only carol
    assert fresh_db.users.count_documents({"studio_token_version": {"$exists": True}}) == 1
    assert fresh_db.studio_migrations.count_documents({}) == 0


def test_commit_backfills_and_adds_studio(fresh_db):
    proc = _run(["--commit", "--studio-users", "alice"])
    assert proc.returncode == 0, proc.stderr
    # All 3 users now have subscriptions and studio_token_version
    assert fresh_db.users.count_documents({"subscriptions": {"$exists": True}}) == 3
    assert fresh_db.users.count_documents({"studio_token_version": {"$exists": True}}) == 3
    # Alice gets studio added
    alice = fresh_db.users.find_one({"user_id": "alice"})
    assert "studio" in alice["subscriptions"]
    assert "platform" in alice["subscriptions"]
    # Bob gets platform-only (default backfill)
    bob = fresh_db.users.find_one({"user_id": "bob"})
    assert bob["subscriptions"] == ["platform"]
    # Carol's existing subscriptions unchanged (still ["platform"])
    carol = fresh_db.users.find_one({"user_id": "carol"})
    assert carol["subscriptions"] == ["platform"]
    assert carol["studio_token_version"] == 7  # unchanged
    # Audit row appended
    assert fresh_db.studio_migrations.count_documents(
        {"name": "studio_006_add_subscriptions"}
    ) == 1


def test_rerun_is_idempotent_per_record(fresh_db):
    _run(["--commit", "--studio-users", "alice"])
    _run(["--commit", "--studio-users", "alice"])
    # subscriptions still ["platform","studio"] (no duplicate)
    alice = fresh_db.users.find_one({"user_id": "alice"})
    assert alice["subscriptions"].count("studio") == 1
    assert alice["subscriptions"].count("platform") == 1
    # Audit appended both times
    assert fresh_db.studio_migrations.count_documents(
        {"name": "studio_006_add_subscriptions"}
    ) == 2


def test_explicit_studio_users_list(fresh_db):
    _run(["--commit", "--studio-users", "alice", "bob"])
    for uid in ("alice", "bob"):
        u = fresh_db.users.find_one({"user_id": uid})
        assert "studio" in u["subscriptions"]
    carol = fresh_db.users.find_one({"user_id": "carol"})
    assert "studio" not in carol["subscriptions"]
