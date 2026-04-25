"""One-shot: tag pre-PR2 task_queue.json entries with user_id.

Pre-PR2 entries lack `user_id`, so PR2's _load() drops them on backend
restart (decision #9 — they have no safe owner to assign automatically).
On a single-operator dev box where every legacy task came from one
person, the safe move is to backfill them with that person's user_id.

Idempotent: only touches entries without `user_id`. Re-running is a no-op.
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

QUEUE_FILE = Path(__file__).resolve().parent.parent / "outputs" / "task_queue.json"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--owner", required=True,
                   help="user_id to stamp on every ownerless entry")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--queue-file", default=str(QUEUE_FILE))
    args = p.parse_args()

    qf = Path(args.queue_file)
    if not qf.exists():
        print(f"  no queue file at {qf}; nothing to do.")
        return 0

    data = json.loads(qf.read_text(encoding="utf-8"))
    queue = data.get("queue", [])
    ownerless = [e for e in queue if not e.get("user_id")]
    owned = [e for e in queue if e.get("user_id")]

    print(f"  queue file:      {qf}")
    print(f"  total entries:   {len(queue)}")
    print(f"  with user_id:    {len(owned)}")
    print(f"  ownerless:       {len(ownerless)}  (will tag with user_id={args.owner!r})")

    if args.dry_run or not ownerless:
        print("\n  --dry-run (or nothing to do): no writes.")
        return 0

    backup = qf.with_suffix(".json.bak")
    shutil.copyfile(qf, backup)
    print(f"\n  backed up → {backup}")

    for e in ownerless:
        e["user_id"] = args.owner
    qf.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  wrote {qf} with {len(ownerless)} ownership additions.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
