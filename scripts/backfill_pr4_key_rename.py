"""PR-4 1회 backfill — `storage_key`/`path` → `key`, `imageUrl` → `url`.

Run after deploying PR-4 to fold legacy field names in studio_results /
studio_hosts / studio_saved_hosts onto the canonical `key`+`url` shape.
The backend continues to read both shapes (legacy fallbacks in
`_ensure_manifest_urls` + repo serializers) until this script lands —
once it lands, the fallbacks become dead code and can be torn out in a
follow-up cleanup commit.

Usage:
    MONGO_URL='mongodb://...' DB_NAME='ai_showhost' \
        python scripts/backfill_pr4_key_rename.py [--dry-run]

Dry-run prints affected counts but mutates nothing.

Idempotent: re-running after success is a no-op.

The script does NOT touch `params.host_image` / `params.audio_path` /
`params.reference_image_paths` — those are wire form-field identifiers
the frontend submits as values; they remain `*_path`-suffixed on the
manifest because that's what the worker consumed at dispatch time. They
are still readable by the post-PR-4 backend (safe_input_value accepts
both absolute paths and storage_keys).
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import Any

from pymongo import MongoClient


def _normalize_to_storage_key(value: str | None) -> str | None:
    """Coerce a legacy absolute path or a storage_key to the storage_key
    form (`outputs/...` / `uploads/...` / `examples/...`). Returns None
    when no bucket prefix can be located. Mirrors app.py's helper."""
    if not value or not isinstance(value, str):
        return None
    if "/" in value and not value.startswith("/"):
        head = value.split("/", 1)[0]
        if head in ("outputs", "uploads", "examples"):
            return value
    parts = value.replace("\\", "/").split("/")
    for prefix in ("outputs", "uploads", "examples"):
        if prefix in parts:
            idx = parts.index(prefix)
            return "/".join(parts[idx:])
    return None


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true", help="report only, no writes")
    args = p.parse_args()

    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        print("error: MONGO_URL and DB_NAME must be set in env.", file=sys.stderr)
        return 1

    client = MongoClient(mongo_url, serverSelectionTimeoutMS=5000)
    db = client[db_name]

    print(f"Backfill target: {db_name} on {mongo_url.split('@')[-1]}")
    if args.dry_run:
        print("DRY RUN — no writes will happen.\n")

    summary: dict[str, int] = {}

    # 1. studio_hosts: rename `storage_key` → `key` (pure column rename).
    coll = db["studio_hosts"]
    n_with_old = coll.count_documents({"storage_key": {"$exists": True}, "key": {"$exists": False}})
    print(f"[studio_hosts] rows with legacy `storage_key` only: {n_with_old}")
    if not args.dry_run and n_with_old > 0:
        coll.update_many(
            {"storage_key": {"$exists": True}, "key": {"$exists": False}},
            {"$rename": {"storage_key": "key"}},
        )
    summary["studio_hosts.storage_key→key"] = n_with_old

    # 2. studio_saved_hosts: same rename.
    coll = db["studio_saved_hosts"]
    n_with_old = coll.count_documents({"storage_key": {"$exists": True}, "key": {"$exists": False}})
    print(f"[studio_saved_hosts] rows with legacy `storage_key` only: {n_with_old}")
    if not args.dry_run and n_with_old > 0:
        coll.update_many(
            {"storage_key": {"$exists": True}, "key": {"$exists": False}},
            {"$rename": {"storage_key": "key"}},
        )
    summary["studio_saved_hosts.storage_key→key"] = n_with_old

    # 3. studio_results.video_storage_key → video_key.
    coll = db["studio_results"]
    n_with_old = coll.count_documents(
        {"video_storage_key": {"$exists": True}, "video_key": {"$exists": False}}
    )
    print(f"[studio_results] rows with legacy `video_storage_key` only: {n_with_old}")
    if not args.dry_run and n_with_old > 0:
        coll.update_many(
            {"video_storage_key": {"$exists": True}, "video_key": {"$exists": False}},
            {"$rename": {"video_storage_key": "video_key"}},
        )
    summary["studio_results.video_storage_key→video_key"] = n_with_old

    # 4. studio_results.meta.background — promote uploadPath/imageUrl to key/url.
    bg_promoted = 0
    bg_targets = coll.find(
        {
            "meta.background.source": "upload",
            "$or": [
                {"meta.background.key": {"$exists": False}, "meta.background.uploadPath": {"$exists": True}},
                {"meta.background.url": {"$exists": False}, "meta.background.imageUrl": {"$exists": True}},
            ],
        },
        {"_id": 1, "meta.background": 1},
    )
    for doc in bg_targets:
        bg = doc.get("meta", {}).get("background", {}) or {}
        updates: dict[str, Any] = {}
        if not bg.get("key"):
            key = _normalize_to_storage_key(bg.get("uploadPath"))
            if key:
                updates["meta.background.key"] = key
        if not bg.get("url") and bg.get("imageUrl"):
            updates["meta.background.url"] = bg["imageUrl"]
        if updates:
            bg_promoted += 1
            if not args.dry_run:
                coll.update_one({"_id": doc["_id"]}, {"$set": updates})
    summary["studio_results.meta.background.{key,url}"] = bg_promoted
    print(f"[studio_results] meta.background entries promoted: {bg_promoted}")

    # 5. studio_results.meta.products[].path/url — promote to key/url.
    products_promoted = 0
    product_targets = coll.find(
        {"meta.products": {"$exists": True, "$type": "array"}},
        {"_id": 1, "meta.products": 1},
    )
    for doc in product_targets:
        products = doc.get("meta", {}).get("products") or []
        new_products = []
        changed = False
        for p in products:
            if not isinstance(p, dict):
                new_products.append(p)
                continue
            new_p = dict(p)
            if "key" not in new_p:
                ref = _normalize_to_storage_key(new_p.get("path"))
                if ref:
                    new_p["key"] = ref
                    changed = True
            if "url" not in new_p and new_p.get("imageUrl"):
                new_p["url"] = new_p["imageUrl"]
                changed = True
            new_products.append(new_p)
        if changed:
            products_promoted += 1
            if not args.dry_run:
                coll.update_one({"_id": doc["_id"]}, {"$set": {"meta.products": new_products}})
    summary["studio_results.meta.products[].{key,url}"] = products_promoted
    print(f"[studio_results] meta.products[] rows promoted: {products_promoted}")

    print("\n=== summary ===")
    for k, v in summary.items():
        print(f"  {k}: {v}")
    print()

    if args.dry_run:
        print("DRY RUN complete. Re-run without --dry-run to apply.")
    else:
        print("Backfill complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
