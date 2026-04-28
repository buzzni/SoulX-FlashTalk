"""Tests for scripts/studio_008_generation_jobs.py.

The migration script lays down the generation_jobs indexes ahead of the
FastAPI startup hook. The script's _INDEXES list MUST stay in sync with
modules.db.init_indexes — drift here means a deploy-time index that
differs from the runtime spec, which pymongo treats as a duplicate
and refuses to coalesce. So this test suite asserts:

  1. Dry-run prints the plan and exits clean without writing.
  2. Commit creates every index with the right shape (unique +
     partial filter) and writes the studio_migrations audit row.
  3. Re-running commit is idempotent (no duplicate indexes; new audit row).
  4. assert_local_only refuses non-local URLs / non-dev DB names.
"""
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
    return f"ai_showhost_test_{worker}_studio008"


@pytest.fixture
def fresh_db():
    """Per-worker DB, dropped before and after each test."""
    client = MongoClient(
        "mongodb://localhost:27017",
        serverSelectionTimeoutMS=5000,
    )
    db = client[_test_db_name()]
    for coll in db.list_collection_names():
        db[coll].drop()
    yield db
    for coll in db.list_collection_names():
        db[coll].drop()
    client.close()


def _run(args: list[str]) -> subprocess.CompletedProcess:
    """Spawn the migration script as a subprocess; the script does its
    own MongoClient construction so we don't share connections.

    The script uses logging.basicConfig which defaults to stderr — so
    callers checking script output must consult `out.stderr`, not stdout.
    """
    return subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "studio_008_generation_jobs.py"),
            *args,
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env={
            **os.environ,
            "DB_NAME": _test_db_name(),
            "MONGO_URL": "mongodb://localhost:27017",
        },
    )


def test_dry_run_does_not_write(fresh_db):
    """--dry-run lists the plan but creates nothing."""
    result = _run(["--dry-run"])
    assert result.returncode == 0, result.stderr
    output = result.stdout + result.stderr
    assert "DRY-RUN" in output
    assert "no writes" in output

    # generation_jobs collection wasn't created (or has only the implicit
    # _id index if pymongo touched it during list_indexes).
    idx_names = {ix["name"] for ix in fresh_db.generation_jobs.list_indexes()}
    # Only _id_ should exist (auto). None of the eng-spec §7 indexes.
    assert idx_names <= {"_id_"}
    assert "studio_migrations" not in fresh_db.list_collection_names()


def test_commit_creates_all_indexes_with_right_shape(fresh_db):
    """Each index in _INDEXES must be created with the unique flag and
    partialFilterExpression that match modules.db.init_indexes."""
    result = _run(["--commit"])
    assert result.returncode == 0, result.stderr
    assert "committed" in (result.stdout + result.stderr)

    by_name = {ix["name"]: ix for ix in fresh_db.generation_jobs.list_indexes()}

    # Same five indexes asserted in test_studio_jobs_repo.test_indexes_present
    # — the script and the runtime hook must both produce identical specs.
    assert "user_kind_created" in by_name
    assert not by_name["user_kind_created"].get("unique", False)
    assert "partialFilterExpression" not in by_name["user_kind_created"]

    assert "state_heartbeat_streaming" in by_name
    assert by_name["state_heartbeat_streaming"]["partialFilterExpression"] == {
        "state": "streaming"
    }

    assert "state_updated_terminal" in by_name
    assert by_name["state_updated_terminal"]["partialFilterExpression"] == {
        "state": {"$in": ["ready", "failed", "cancelled"]}
    }

    dedupe = by_name["user_input_hash_active_uniq"]
    assert dedupe["unique"] is True
    assert dedupe["partialFilterExpression"] == {
        "state": {"$in": ["pending", "streaming"]}
    }

    assert "state_idx" in by_name
    assert "partialFilterExpression" not in by_name["state_idx"]


def test_commit_writes_migration_audit_row(fresh_db):
    _run(["--commit"])
    rows = list(fresh_db.studio_migrations.find({}))
    assert len(rows) == 1
    assert rows[0]["name"] == "studio_008_generation_jobs"
    assert "indexes ensured" in rows[0]["result"]


def test_commit_is_idempotent(fresh_db):
    """Re-running --commit must not create duplicate indexes (pymongo
    coalesces matching specs). Audit row appends per the eng-spec
    decision #13 (append-only studio_migrations)."""
    a = _run(["--commit"])
    b = _run(["--commit"])
    assert a.returncode == 0 and b.returncode == 0

    by_name = {ix["name"] for ix in fresh_db.generation_jobs.list_indexes()}
    expected = {
        "_id_",
        "user_kind_created",
        "state_heartbeat_streaming",
        "state_updated_terminal",
        "user_input_hash_active_uniq",
        "state_idx",
    }
    assert by_name == expected

    rows = list(fresh_db.studio_migrations.find({}))
    assert len(rows) == 2  # append-only audit


def test_refuses_non_local_mongo_url(fresh_db):
    """Safety: assert_local_only must refuse a non-localhost URL.
    Verified at the script level, not the helper, to catch wiring drift."""
    result = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "studio_008_generation_jobs.py"),
            "--commit",
            "--mongo-url", "mongodb://prod-cluster.example.com:27017",
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env={**os.environ, "DB_NAME": _test_db_name()},
    )
    assert result.returncode != 0
    assert "not localhost" in (result.stdout + result.stderr)


def test_refuses_non_dev_db_name():
    """Even on localhost, a prod-shaped DB name is refused."""
    result = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "studio_008_generation_jobs.py"),
            "--commit",
            "--db-name", "production_data",
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env={**os.environ, "MONGO_URL": "mongodb://localhost:27017"},
    )
    assert result.returncode != 0
    assert "not an allowed dev DB" in (result.stdout + result.stderr)
