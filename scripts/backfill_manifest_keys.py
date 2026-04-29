"""1회 backfill — studio_results 의 손상된 manifest params 를 storage_key 로 복구.

배경
----
generate worker (`app.py:generate_video_task`) 가 `_resolve_input_to_local`
호출 시 `host_image` / `audio_path` 로컬 변수를 temp 절대경로로 덮어쓰고,
그대로 manifest 의 `params` 에 저장하던 버그가 있었다. 그 결과 row 의
`params.host_image` / `params.audio_path` 가 `/opt/.../temp/job-input-*.png`
형태로 박혀, 이후 `_ensure_manifest_urls` 에서 storage_key 정규화 실패 →
result page 에서 1·2단계 이미지/오디오 깨짐.

복구 우선순위
-------------
1. `generation_jobs` 컬렉션의 동일 task_id row 가 살아있으면 거기서 원본
   storage_key 사용 (worker 가 entry["params"] 의 *복사본* 만 mutate 하므로
   queue row 는 손대지 않음 — 정상 storage_key 가 살아있는 경우 多).
2. generation_jobs 가 prune 된 row 만:
   - host_image: meta.composition.selectedPath (composite) → meta.host.selectedPath
   - audio_path: 복구 불가 (meta.voice 어디에도 audio 의 storage_key 가 없음)
     → None 으로 정리. 사용자는 result page 진입 시 audio 만 빈 상태로 표시,
       "수정해서 다시 만들기" → step 3 에서 다시 음성 만들기.

Usage:
    MONGO_URL='mongodb://...' DB_NAME='ai_showhost' \
        python scripts/backfill_manifest_keys.py [--dry-run]

Idempotent: 두 번 돌려도 안전 (이미 정상 storage_key 인 row 는 skip).
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import Any, Optional

from dotenv import load_dotenv
from pymongo import MongoClient

# Load .env so MONGO_URL / DB_NAME match the running app without needing
# the operator to re-export them.
load_dotenv()


def _normalize_to_storage_key(value: Optional[str]) -> Optional[str]:
    """Mirror of app.py:_normalize_to_storage_key."""
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


def _is_temp_path(value: Any) -> bool:
    """A value is corrupted if it's a string that doesn't normalize to a
    storage_key (i.e. an absolute /opt/.../temp/... path)."""
    return isinstance(value, str) and value != "" and _normalize_to_storage_key(value) is None


def _recover_host_image(
    sr_row: dict,
    gj_row: Optional[dict],
) -> Optional[str]:
    """Resolve a fresh host_image storage_key for a damaged row."""
    # 1) generation_jobs cross-check
    if gj_row is not None:
        gj_params = gj_row.get("params") or {}
        gj_host = gj_params.get("host_image")
        key = _normalize_to_storage_key(gj_host)
        if key:
            return key
    # 2) meta.composition.selectedPath (the actual frame FlashTalk used)
    meta = sr_row.get("meta") or {}
    comp = meta.get("composition") or {}
    key = _normalize_to_storage_key(comp.get("selectedPath"))
    if key:
        return key
    # 3) meta.host.selectedPath (Step 1 host-only image; only correct when
    #    no Step 2 composite was generated, which is the rare case)
    host = meta.get("host") or {}
    key = _normalize_to_storage_key(host.get("selectedPath"))
    if key:
        return key
    return None


def _recover_audio(
    sr_row: dict,
    gj_row: Optional[dict],
) -> Optional[str]:
    """Resolve a fresh audio_path storage_key. Returns None if the audio
    is permanently lost (generation_jobs pruned and meta has no key)."""
    if gj_row is not None:
        gj_params = gj_row.get("params") or {}
        key = _normalize_to_storage_key(gj_params.get("audio_path"))
        if key:
            return key
    # meta.voice does not carry an audio storage_key — checked the schema
    # against the dispatch code (app.py / api/video.ts).
    return None


def _recover_ref_paths(
    sr_row: dict,
    gj_row: Optional[dict],
) -> list[str]:
    """Replace any temp absolute paths in reference_image_paths with the
    original storage_keys from generation_jobs, or drop them."""
    sr_params = sr_row.get("params") or {}
    refs = sr_params.get("reference_image_paths") or []
    if not isinstance(refs, list):
        return []
    if all(not _is_temp_path(r) for r in refs):
        return list(refs)  # already clean
    if gj_row is not None:
        gj_params = gj_row.get("params") or {}
        gj_refs = gj_params.get("reference_image_paths") or []
        if isinstance(gj_refs, list):
            recovered = [
                _normalize_to_storage_key(r) for r in gj_refs
            ]
            return [r for r in recovered if r]
    # Drop unrecoverable refs rather than persisting temp paths.
    return [r for r in refs if not _is_temp_path(r)]


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true", help="report only, no writes")
    args = p.parse_args()

    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        print("ERROR: MONGO_URL and DB_NAME env vars required", file=sys.stderr)
        return 2

    client = MongoClient(mongo_url)
    db = client[db_name]
    sr_coll = db["studio_results"]
    gj_coll = db["generation_jobs"]

    # Cheap pre-filter: any row whose params.host_image OR params.audio_path
    # starts with a leading slash is a candidate. We can't filter purely by
    # regex on Mongo because temp paths vary (`/opt/.../temp/...`,
    # `/tmp/...`), so we pull anything starting with "/" and let the
    # _normalize_to_storage_key check decide.
    candidates_q = {
        "$or": [
            {"params.host_image": {"$regex": "^/"}},
            {"params.audio_path": {"$regex": "^/"}},
            {"params.reference_image_paths": {"$elemMatch": {"$regex": "^/"}}},
        ],
    }
    total_candidates = sr_coll.count_documents(candidates_q)
    print(f"candidates: {total_candidates} studio_results rows with absolute paths")

    fixed = 0
    audio_recovered = 0
    audio_lost = 0
    host_recovered = 0
    host_lost = 0
    skipped = 0

    for sr in sr_coll.find(candidates_q):
        task_id = sr.get("task_id")
        if not task_id:
            continue
        gj = gj_coll.find_one({"task_id": task_id})

        sr_params = sr.get("params") or {}
        old_host = sr_params.get("host_image")
        old_audio = sr_params.get("audio_path")
        old_refs = sr_params.get("reference_image_paths") or []

        new_host = old_host
        new_audio = old_audio
        if _is_temp_path(old_host):
            recovered = _recover_host_image(sr, gj)
            new_host = recovered  # may be None (legitimately unrecoverable)
            if recovered:
                host_recovered += 1
            else:
                host_lost += 1
        if _is_temp_path(old_audio):
            recovered = _recover_audio(sr, gj)
            new_audio = recovered
            if recovered:
                audio_recovered += 1
            else:
                audio_lost += 1
        new_refs = _recover_ref_paths(sr, gj)

        # If nothing changed (only stray fields, false positive on regex),
        # skip persisting.
        unchanged = (
            new_host == old_host
            and new_audio == old_audio
            and list(new_refs) == list(old_refs)
        )
        if unchanged:
            skipped += 1
            continue

        print(
            f"task {task_id}\n"
            f"  host_image: {old_host!r}\n"
            f"          -> {new_host!r}\n"
            f"  audio_path: {old_audio!r}\n"
            f"          -> {new_audio!r}\n"
            f"  ref_paths : {old_refs!r}\n"
            f"          -> {new_refs!r}"
        )

        if not args.dry_run:
            update = {
                "$set": {
                    "params.host_image": new_host,
                    "params.audio_path": new_audio,
                    "params.reference_image_paths": new_refs,
                }
            }
            sr_coll.update_one({"_id": sr["_id"]}, update)
        fixed += 1

    print(
        "\n=== summary ===\n"
        f"candidates:       {total_candidates}\n"
        f"fixed:            {fixed}{' (dry-run)' if args.dry_run else ''}\n"
        f"  host recovered: {host_recovered}\n"
        f"  host lost:      {host_lost}\n"
        f"  audio recovered:{audio_recovered}\n"
        f"  audio lost:     {audio_lost}\n"
        f"skipped (no-op):  {skipped}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
