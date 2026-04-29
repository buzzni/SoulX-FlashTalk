#!/usr/bin/env python3
"""Sync examples/ seed assets into the active media_store.

PR S3+ C12 — one-shot helper to run before C13 cutover. After this
script succeeds the storage backend has every file under
`examples/<basename>` so:

    config.DEFAULT_HOST_IMAGE   = "examples/woman.png"
    config.DEFAULT_HOST_IMAGE_M = "examples/man_default.png"
    config.DEFAULT_AUDIO        = "examples/cantonese_16k.wav"

…can be downloaded via `media_store.open_local()` or
`media_store.download_to()` regardless of which backend is live.

Idempotent: re-running just overwrites with the same bytes
(`media_store.upload` is atomic on LocalDisk and S3).

Usage:
    python -m scripts.upload_examples_to_s3
    python -m scripts.upload_examples_to_s3 --dry-run

The script imports the active media_store, so on the dev host (with
LocalDisk default) it's a no-op same-file copy. On the cutover-day
machine (`MEDIA_STORE_BACKEND=s3` style env) it does the real PUTs.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List the files that would be uploaded without uploading.",
    )
    parser.add_argument(
        "--examples-dir",
        default=None,
        help="Override the examples directory (default: config.EXAMPLES_DIR).",
    )
    args = parser.parse_args()

    # Late imports so --help works without booting the app.
    repo_root = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(repo_root))
    import config
    from modules import storage as _storage

    examples_dir = Path(args.examples_dir or config.EXAMPLES_DIR)
    if not examples_dir.is_dir():
        print(f"ERROR: examples dir not found: {examples_dir}", file=sys.stderr)
        return 1

    files = sorted(p for p in examples_dir.iterdir() if p.is_file())
    if not files:
        print(f"No files in {examples_dir} — nothing to sync.")
        return 0

    print(f"Found {len(files)} seed file(s) in {examples_dir}:")
    for p in files:
        print(f"  {p.name}  ({p.stat().st_size} bytes)")

    if args.dry_run:
        print("\n[dry-run] would upload to media_store under examples/<basename>")
        return 0

    print(f"\nUploading via {type(_storage.media_store).__name__}...")
    for p in files:
        key = f"examples/{p.name}"
        try:
            _storage.media_store.upload(p, key)
            print(f"  ok  {key}")
        except Exception as e:
            print(f"  FAIL {key}: {e}", file=sys.stderr)
            return 2

    print(f"\nDone — {len(files)} file(s) synced.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
