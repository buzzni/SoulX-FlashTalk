#!/usr/bin/env python3
"""One-shot migration: tag every pre-existing host/composite candidate
as `status='committed'` (orphan, video_ids=[]) so the lifecycle module
treats them as permanent (won't sweep them at the next generate) but
also doesn't surface them in `get_state.drafts/selected/prev_selected`.

User decision recap (see thread): keep all existing files, mark them
committed-orphan. Migration is idempotent — running twice is safe.

Run:
    .venv/bin/python scripts/migrate_lifecycle.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from modules import lifecycle  # noqa: E402


def main() -> int:
    grand_total = 0
    for step in ("host", "composite"):
        result = lifecycle.migrate_existing_to_committed(step)  # type: ignore[arg-type]
        print(
            f"[{step}] touched={result['touched']} "
            f"already_tracked={result['already_tracked']} "
            f"sidecar_created={result['sidecar_created']}"
        )
        grand_total += result["touched"] + result["already_tracked"]
    print(f"Total candidates accounted for: {grand_total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
