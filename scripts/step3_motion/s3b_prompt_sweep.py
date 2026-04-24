"""Serial S3-B prompt sweep (spec v3 §4.3).

Runs run_eval.py against p-v0 (control), p-v1, p-v2 in sequence. Backend
queue is single-worker, so parallelism is impossible.

Usage (from repo root):
    python scripts/step3_motion/s3b_prompt_sweep.py --backend http://localhost:8001
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = REPO_ROOT / "eval" / "step3" / "configs"
CONFIGS = ["s3b-p-v0", "s3b-p-v1", "s3b-p-v2"]


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--backend", default="http://localhost:8001")
    p.add_argument(
        "--fixtures-meta-dir",
        default="eval/step3/fixtures-meta",
    )
    p.add_argument("--output-dir", default="eval/step3/results")
    args = p.parse_args()

    for config_id in CONFIGS:
        config_path = CONFIG_DIR / f"{config_id}.yaml"
        if not config_path.exists():
            print(f"Missing config: {config_path}", file=sys.stderr)
            return 2
        print(f"=== Running {config_id} ===", flush=True)
        rc = subprocess.run(
            [
                sys.executable, "-m", "eval.step3.run_eval",
                "--config", str(config_path),
                "--run-id", config_id,
                "--fixtures-meta-dir", args.fixtures_meta_dir,
                "--output-dir", args.output_dir,
                "--backend", args.backend,
            ],
            cwd=REPO_ROOT,
        ).returncode
        if rc != 0:
            print(f"run_eval exited {rc} for {config_id}; continuing", file=sys.stderr)

    print("Sweep complete. Next: operator scores blind/ dirs per RUBRIC.md.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
