"""Seed the local dev DB with known-password users for hand-testing.

Idempotent: re-running upserts in place; existing data isn't disturbed
beyond the listed fields. Refuses to run unless MONGO_URL points at
localhost AND DB_NAME is an ai_showhost dev/test name.

Note (PR0+): only seeds the synthetic dev users (testuser, noaccess).
The `jack` account is intentionally NOT seeded here because the dev DB
holds the real prod-shaped jack record (real bcrypt hash, role="admin",
hashkey, refresh_token_hashes, etc.) so the operator can log in with the
actual prod password. Running this script does NOT touch jack.

Usage:
    .venv/bin/python scripts/seed_dev_db.py
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import bcrypt
from dotenv import load_dotenv
from pymongo import MongoClient

from scripts._lib import assert_local_only, record_migration


load_dotenv()
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "ai_showhost")


def _hash_password(plaintext: str) -> str:
    """bcrypt $2b$12$... — same format the prod users collection already uses."""
    return bcrypt.hashpw(plaintext.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


SEED_USERS = [
    {
        "user_id": "testuser",
        "password": "test1234",
        "display_name": "Test User (studio access)",
        "role": "member",
        "subscriptions": ["platform", "studio"],
    },
    {
        "user_id": "noaccess",
        "password": "test1234",
        "display_name": "Test User (platform only)",
        "role": "member",
        "subscriptions": ["platform"],
    },
]


def main() -> int:
    assert_local_only(MONGO_URL, DB_NAME)

    client = MongoClient(MONGO_URL, serverSelectionTimeoutMS=5000)
    client.admin.command("ping")
    db = client[DB_NAME]
    users = db["users"]

    now = datetime.now(timezone.utc)
    upserted = 0
    for u in SEED_USERS:
        users.update_one(
            {"user_id": u["user_id"]},
            {
                "$set": {
                    "user_id": u["user_id"],
                    "display_name": u["display_name"],
                    "hashed_password": _hash_password(u["password"]),
                    "role": u["role"],
                    "is_active": True,
                    "approval_status": "approved",
                    "must_change_password": False,
                    "password_bootstrapped": False,
                    "subscriptions": u["subscriptions"],
                    "studio_token_version": 0,
                    "last_active_at": now,
                },
                "$setOnInsert": {"created_at": now, "token_version": 0},
            },
            upsert=True,
        )
        upserted += 1
        print(
            f"  ✓ upserted user_id={u['user_id']} role={u['role']} "
            f"subscriptions={u['subscriptions']}"
        )

    record_migration(db, "seed_dev_db", f"{upserted} users upserted")
    n_total = users.count_documents({})
    print(f"\nDone. seeded {upserted}; total users in {DB_NAME}.users = {n_total}.")
    print(
        "Login passwords (DEV ONLY — do not use these on prod):\n"
        "  testuser  : test1234   (subscriptions: platform+studio)\n"
        "  noaccess  : test1234   (subscriptions: platform only)\n"
        "  jack      : (real prod password — record imported separately, not touched here)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
