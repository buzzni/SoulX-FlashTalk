"""CLI: join blind-scored UUIDs back to (fixture_id, config_id) pairs.

Reads <run-dir>/_blind_map.json + <run-dir>/scores.json, writes
<run-dir>/joined_scores.json, prints a yes-rate summary.

Usage:
    python -m eval.step3.join_scores --run-dir eval/step3/results/<run-id>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from eval.step3.rubric import load_blind_map, load_blind_scores, join_scores, yes_rate


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--run-dir", required=True)
    args = p.parse_args()

    run_dir = Path(args.run_dir)
    blind_map_path = run_dir / "_blind_map.json"
    scores_path = run_dir / "scores.json"
    if not blind_map_path.exists():
        print(f"Missing {blind_map_path}", file=sys.stderr)
        return 2
    if not scores_path.exists():
        print(f"Missing {scores_path} — have you scored yet?", file=sys.stderr)
        return 2

    blind_map = load_blind_map(blind_map_path)
    blind_scores = load_blind_scores(scores_path)
    joined = join_scores(blind_map, blind_scores)

    out_path = run_dir / "joined_scores.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump([j.model_dump() for j in joined], f, indent=2)

    config_ids = sorted({j.config_id for j in joined})
    print(f"Joined {len(joined)} scores → {out_path}")
    print("Yes-rate by config:")
    for config_id in config_ids:
        yes, total = yes_rate(joined, config_id)
        print(f"  {config_id}: {yes}/{total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
