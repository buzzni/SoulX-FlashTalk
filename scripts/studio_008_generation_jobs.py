"""studio_008 — provision the `generation_jobs` collection + indexes.

Backs the streaming-resume feature (docs/plans/streaming-resume-eng-spec.md §7).
The collection has no rows to backfill; this script's job is to lay down the
indexes ahead of the FastAPI startup hook (`modules.db.init_indexes`) so a
deploy can run the migration before the rolling restart.

Indexes (eng-spec §7):
- {user_id, kind, created_at desc}                                  list pagination
- {state, heartbeat_at}              partial state="streaming"      stuck-job sweep
- {state, updated_at}                partial state in terminal      TTL sweep
- {user_id, input_hash}      unique  partial state in active        dedupe-by-reuse

Idempotent: pymongo's create_index is a no-op when the spec already exists.
Re-running appends another studio_migrations audit row (decision #13).

Usage:
    .venv/bin/python scripts/studio_008_generation_jobs.py --dry-run
    .venv/bin/python scripts/studio_008_generation_jobs.py --commit
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv
from pymongo import MongoClient

from scripts._lib import assert_local_only, record_migration

logger = logging.getLogger("studio_008")
logging.basicConfig(level=logging.INFO, format="%(message)s")


load_dotenv()
DEFAULT_MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DEFAULT_DB_NAME = os.environ.get("DB_NAME", "ai_showhost")


# Mirrors modules.db.init_indexes — kept in sync by inspection (the partial
# filter shapes here MUST match the runtime ones, or pymongo will treat them
# as different specs and create a duplicate index).
_INDEXES = [
    dict(
        keys=[("user_id", 1), ("kind", 1), ("created_at", -1)],
        name="user_kind_created",
        unique=False,
        partialFilterExpression=None,
    ),
    dict(
        keys=[("state", 1), ("heartbeat_at", 1)],
        name="state_heartbeat_streaming",
        unique=False,
        partialFilterExpression={"state": "streaming"},
    ),
    dict(
        keys=[("state", 1), ("updated_at", 1)],
        name="state_updated_terminal",
        unique=False,
        partialFilterExpression={
            "state": {"$in": ["ready", "failed", "cancelled"]}
        },
    ),
    dict(
        keys=[("user_id", 1), ("input_hash", 1)],
        name="user_input_hash_active_uniq",
        unique=True,
        partialFilterExpression={
            "state": {"$in": ["pending", "streaming"]}
        },
    ),
]


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    grp = p.add_mutually_exclusive_group()
    grp.add_argument("--commit", action="store_true",
                     help="apply the migration")
    grp.add_argument("--dry-run", action="store_true",
                     help="show planned actions only (default mode)")
    p.add_argument("--mongo-url", default=DEFAULT_MONGO_URL)
    p.add_argument("--db-name", default=DEFAULT_DB_NAME)
    return p.parse_args()


def main() -> int:
    args = _parse_args()
    assert_local_only(args.mongo_url, args.db_name)

    client = MongoClient(args.mongo_url, serverSelectionTimeoutMS=5000)
    client.admin.command("ping")
    db = client[args.db_name]
    coll = db["generation_jobs"]

    n_existing = coll.count_documents({})
    existing_indexes = {ix["name"] for ix in coll.list_indexes()}

    mode = "COMMIT" if args.commit else "DRY-RUN"
    logger.info("=== studio_008_generation_jobs [%s] ===", mode)
    logger.info("  target:                %s / %s", args.mongo_url, args.db_name)
    logger.info("  generation_jobs rows:  %d", n_existing)
    logger.info("  existing indexes:      %s", sorted(existing_indexes))
    logger.info("  planned indexes:")
    for spec in _INDEXES:
        marker = "✓ already" if spec["name"] in existing_indexes else "+ new"
        logger.info("    %s  %s", marker, spec["name"])

    if not args.commit:
        logger.info("\n  --dry-run: no writes. Re-run with --commit to apply.")
        return 0

    created: list[str] = []
    for spec in _INDEXES:
        kwargs: dict = {"name": spec["name"], "unique": spec["unique"]}
        if spec["partialFilterExpression"] is not None:
            kwargs["partialFilterExpression"] = spec["partialFilterExpression"]
        coll.create_index(spec["keys"], **kwargs)
        created.append(spec["name"])

    summary = (
        f"generation_jobs ensured; rows={n_existing}; "
        f"indexes ensured={created}"
    )
    record_migration(db, "studio_008_generation_jobs", summary)
    logger.info("\n  ✓ committed. %s", summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
