"""One-shot: backfill studio_results rows for failed/cancelled tasks
from outputs/task_queue.json.

Plan decision #20 (BLOCKING): the new /api/history?status=error UI
filters by `status in studio_results`, but pre-PR-results-overhaul code
only wrote rows for `status="completed"`. Failed/cancelled tasks lived
in the task_queue (in-memory + outputs/task_queue.json) and got pruned
to the last 50 finished entries. This script rescues whatever's still
in task_queue.json and writes durable studio_results rows so the
library page has data on day one.

Idempotent: skips entries that already have a studio_results row.

Usage:
    .venv/bin/python scripts/backfill_studio_results_failures.py [--dry-run] [--queue-file PATH]

Run once per environment after deploying the persistence write-path
changes. Re-running is a no-op (each row's task_id is keyed unique
per (user_id, task_id) by the studio_results index).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

QUEUE_FILE = Path(__file__).resolve().parent.parent / "outputs" / "task_queue.json"

# Pre-PR2 task_queue rows lacked user_id; the queue _load() now drops them.
# We follow the same rule — a row without a safe owner can't be backfilled
# because studio_results is user-scoped.
_TARGET_STATUSES = {"error", "cancelled"}


def _parse_iso(value):
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


async def _backfill(queue_file: Path, dry_run: bool) -> int:
    """Returns number of rows written (0 in dry-run)."""
    from modules import db as db_module
    from modules.repositories import studio_result_repo as _result_repo

    if not queue_file.exists():
        print(f"  no queue file at {queue_file}; nothing to backfill.")
        return 0

    await db_module.init()
    try:
        return await _backfill_impl(queue_file, dry_run, db_module, _result_repo)
    finally:
        await db_module.close()


async def _backfill_impl(queue_file: Path, dry_run: bool, db_module, _result_repo) -> int:

    raw = json.loads(queue_file.read_text(encoding="utf-8"))
    queue = raw.get("queue", [])
    candidates = [
        e for e in queue
        if e.get("status") in _TARGET_STATUSES and e.get("user_id")
    ]
    skipped_no_owner = sum(
        1 for e in queue
        if e.get("status") in _TARGET_STATUSES and not e.get("user_id")
    )

    print(f"  queue file:                {queue_file}")
    print(f"  total queue entries:       {len(queue)}")
    print(f"  error/cancelled w/ owner:  {len(candidates)}")
    print(f"  error/cancelled w/o owner: {skipped_no_owner} (skipped)")

    if not candidates:
        return 0

    # Filter out entries that already have a studio_results row.
    db = db_module.get_db()
    coll = db.studio_results
    existing = set()
    async for doc in coll.find(
        {"task_id": {"$in": [e["task_id"] for e in candidates]}},
        projection={"task_id": 1, "_id": 0},
    ):
        existing.add(doc["task_id"])

    to_write = [e for e in candidates if e["task_id"] not in existing]
    already = len(candidates) - len(to_write)
    print(f"  already in studio_results: {already} (idempotent skip)")
    print(f"  to write:                  {len(to_write)}")

    if not to_write:
        return 0

    if dry_run:
        print("\n  --dry-run: no writes performed. Sample of first 3:")
        for e in to_write[:3]:
            print(f"    - task_id={e['task_id']} user={e['user_id']} status={e['status']}")
        return 0

    written = 0
    for e in to_write:
        params = e.get("params") or {}
        playlist_id = params.get("playlist_id")
        await _result_repo.persist_terminal_failure(
            user_id=e["user_id"],
            task_id=e["task_id"],
            type=e.get("type", "generate"),
            status=e["status"],
            error=e.get("error"),
            params=params,
            playlist_id=playlist_id,
            started_at=_parse_iso(e.get("started_at")),
            created_at=_parse_iso(e.get("created_at")),
        )
        written += 1
    print(f"\n  wrote {written} studio_results rows.")
    return written


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dry-run", action="store_true",
                   help="report what would be written without writing")
    p.add_argument("--queue-file", default=str(QUEUE_FILE),
                   help=f"task_queue.json path (default: {QUEUE_FILE})")
    args = p.parse_args()

    load_dotenv()

    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        print("error: MONGO_URL and DB_NAME must be set in env.", file=sys.stderr)
        return 1
    print(f"  MONGO_URL: {mongo_url}")
    print(f"  DB_NAME:   {db_name}")
    print()

    return asyncio.run(_backfill(Path(args.queue_file), args.dry_run))


if __name__ == "__main__":
    sys.exit(0 if main() >= 0 else 1)
