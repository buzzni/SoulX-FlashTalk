"""Shared helpers for studio_*  migration scripts.

assert_local_only() is the safety guard. seed_dev_db.py and
studio_007_local_import.py both run it before any write so a misconfigured
MONGO_URL pointing at the prod cluster cannot accidentally trash real data.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from urllib.parse import urlparse

from pymongo.collection import Collection
from pymongo.database import Database


_LOCALHOST_HOSTS = {"localhost", "127.0.0.1", "::1"}


def assert_local_only(mongo_url: str, db_name: str) -> None:
    """Raise RuntimeError unless mongo_url is localhost AND db_name is an ai_showhost dev DB.

    Allowed db_name values: 'ai_showhost', 'ai_showhost_test', 'ai_showhost_test_<worker>'.
    Any other combination (prod cluster URL, prod-shaped DB name on a non-local
    host, etc.) refuses to proceed.
    """
    parsed = urlparse(mongo_url)
    host = (parsed.hostname or "").lower()
    if host not in _LOCALHOST_HOSTS:
        raise RuntimeError(
            f"refused: MONGO_URL host {host!r} is not localhost. "
            f"This script only runs against a local dev mongod."
        )
    if not re.fullmatch(r"ai_showhost(?:_test(?:_[A-Za-z0-9]+)?)?", db_name):
        raise RuntimeError(
            f"refused: DB_NAME {db_name!r} is not an allowed dev DB name "
            f"(expected: ai_showhost | ai_showhost_test | ai_showhost_test_<worker>)."
        )


def record_migration(db: Database, name: str, result: str) -> None:
    """Append a row to studio_migrations as an audit trail.

    Append-only by design (decision #13): re-running a migration adds another
    row with a fresh applied_at; we never upsert by name. The natural-key
    upserts inside each migration script handle idempotency.
    """
    col: Collection = db["studio_migrations"]
    col.insert_one({
        "name": name,
        "applied_at": datetime.now(timezone.utc),
        "result": result,
    })
