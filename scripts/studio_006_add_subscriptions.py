"""Backfill `subscriptions` and `studio_token_version` on existing users.

This is the only migration we ever run against PROD. It is additive:
- every user without a `subscriptions` field gets `["platform"]`
- every user without `studio_token_version` gets `0`
- specific user_ids (CLI-controlled, default `["jack"]`) get `"studio"`
  added via $addToSet (idempotent, won't duplicate the array entry)

Per plan decision #13, there is NO outer "skip if name in studio_migrations"
guard. Each operation is upsert/$addToSet which is naturally idempotent at
the record level. The `studio_migrations` row is appended at the end as an
audit trail; re-running adds another row.

Usage:
    # against the local dev DB (recommended first)
    .venv/bin/python scripts/studio_006_add_subscriptions.py --dry-run
    .venv/bin/python scripts/studio_006_add_subscriptions.py --commit

    # against prod (final deploy step only — coordinate with platform team)
    MONGO_URL='mongodb://...' DB_NAME='ai_showhost' \\
        .venv/bin/python scripts/studio_006_add_subscriptions.py --commit
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv
from pymongo import MongoClient

from scripts._lib import record_migration


load_dotenv()
DEFAULT_MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DEFAULT_DB_NAME = os.environ.get("DB_NAME", "ai_showhost")


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    grp = p.add_mutually_exclusive_group()
    grp.add_argument("--commit", action="store_true",
                     help="apply the migration")
    grp.add_argument("--dry-run", action="store_true",
                     help="show counts only, write nothing (default mode)")
    p.add_argument("--studio-users", nargs="*", default=["jack"],
                   help="user_ids to grant 'studio' subscription to "
                        "(default: jack)")
    p.add_argument("--mongo-url", default=DEFAULT_MONGO_URL)
    p.add_argument("--db-name", default=DEFAULT_DB_NAME)
    return p.parse_args()


def main() -> int:
    args = _parse_args()
    client = MongoClient(args.mongo_url, serverSelectionTimeoutMS=5000)
    client.admin.command("ping")
    db = client[args.db_name]
    users = db["users"]

    n_total = users.count_documents({})
    n_no_subs = users.count_documents({"subscriptions": {"$exists": False}})
    n_no_stv = users.count_documents({"studio_token_version": {"$exists": False}})
    n_studio_users_present = users.count_documents({"user_id": {"$in": args.studio_users}})

    mode = "COMMIT" if args.commit else "DRY-RUN"
    print(f"=== studio_006_add_subscriptions [{mode}] ===")
    print(f"  target: {args.mongo_url} / {args.db_name}")
    print(f"  users total:                       {n_total}")
    print(f"  users missing 'subscriptions':     {n_no_subs}")
    print(f"  users missing 'studio_token_ver':  {n_no_stv}")
    print(f"  studio_users requested:            {args.studio_users}")
    print(f"  studio_users actually present:     {n_studio_users_present}")

    if not args.commit:
        print("\n  --dry-run: no writes. Re-run with --commit to apply.")
        return 0

    # Backfill missing 'subscriptions' with ['platform']
    r1 = users.update_many(
        {"subscriptions": {"$exists": False}},
        {"$set": {"subscriptions": ["platform"]}},
    )
    # Backfill missing 'studio_token_version' with 0
    r2 = users.update_many(
        {"studio_token_version": {"$exists": False}},
        {"$set": {"studio_token_version": 0}},
    )
    # Add 'studio' to subscriptions for the requested users (idempotent via $addToSet)
    r3 = users.update_many(
        {"user_id": {"$in": args.studio_users}},
        {"$addToSet": {"subscriptions": "studio"}},
    )

    summary = (
        f"subscriptions backfilled={r1.modified_count}, "
        f"studio_token_version backfilled={r2.modified_count}, "
        f"studio added to {r3.modified_count} user(s) "
        f"(requested: {args.studio_users})"
    )
    record_migration(db, "studio_006_add_subscriptions", summary)
    print(f"\n  ✓ committed. {summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
