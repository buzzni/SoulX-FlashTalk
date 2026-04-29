"""studio_hosts collection — candidate avatars under the wizard state machine.

State machine:

    generate
      └─→ status='draft', batch_id set
    select(image_id)
      ├─ target → status='selected'
      └─ other selected (≠ target) → status='draft'  (is_prev_selected unchanged)
    commit(step, video_id)
      ├─ selected → status='committed', append video_id, clear is_prev_selected
      └─ everything else non-committed → deleted (rows + files)
    cascade_delete_by_video(video_id)
      └─ remove video_id from each committed image; if video_ids becomes
         empty → delete the row + file.

Per docs/db-integration-plan.md decisions:
  #4  candidates and saved hosts live in separate collections
      (studio_hosts vs studio_saved_hosts).
  #11 partial unique index on {user_id, step} where status='selected'
      enforces "at most one selected per step per user". select() must
      demote any existing selected before promoting the target.
  #16 storage_key is bucket-prefixed (e.g. "outputs/hosts/saved/host_x.png").

Every method takes user_id as the first arg and scopes its query (decision §7).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from modules import db as db_module
from modules import storage as storage_module

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Internal
# ---------------------------------------------------------------------------

def _coll():
    return db_module.get_db().studio_hosts


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _serialize(doc: dict) -> dict:
    """Reduce a studio_hosts row to the minimal wizard-frontend shape
    (image_id, path, url, batch_id, is_prev_selected, seed, storage_key).

    PR S3+ contract: `storage_key` is the stable field. `path` is a
    backwards-compat field — on LocalDisk it's the real disk path, on
    S3 it falls back to the storage_key (frontend C9 picks `storage_key`
    so the path field stops mattering)."""
    if doc is None:
        return None
    storage_key = doc.get("storage_key", "")
    try:
        url = storage_module.media_store.url_for(storage_key) if storage_key else ""
    except ValueError:
        url = ""
    path = storage_module.legacy_path_for(storage_key)
    return {
        "image_id": doc.get("image_id"),
        "storage_key": storage_key,
        "path": path,
        "url": url,
        "batch_id": doc.get("batch_id"),
        "is_prev_selected": bool(doc.get("is_prev_selected")),
        "seed": doc.get("seed"),
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def get_state(user_id: str, step: str) -> dict:
    """Return current wizard state for a step.

    Shape:
      {
        "selected":      <serialized row | None>,
        "prev_selected": <serialized row | None>,
        "drafts":        list[<serialized row>],
        "committed":     list[<serialized row>],
      }
    """
    selected = None
    prev_selected = None
    drafts: list[dict] = []
    committed: list[dict] = []

    cursor = _coll().find({"user_id": user_id, "step": step})
    async for doc in cursor:
        rec = _serialize(doc)
        status = doc.get("status")
        if status == "selected":
            selected = rec
            if doc.get("is_prev_selected"):
                prev_selected = rec
        elif status == "committed":
            committed.append(rec)
        elif status == "draft":
            if doc.get("is_prev_selected"):
                prev_selected = rec
            else:
                drafts.append(rec)
        # unknown statuses ignored

    return {
        "selected": selected,
        "prev_selected": prev_selected,
        "drafts": drafts,
        "committed": committed,
    }


async def find_by_image_id(user_id: str, image_id: str) -> Optional[dict]:
    return await _coll().find_one({"user_id": user_id, "image_id": image_id})


async def upsert_candidate(
    user_id: str,
    *,
    image_id: str,
    step: str,
    storage_key: str,
    batch_id: Optional[str] = None,
    extra: Optional[dict] = None,
) -> None:
    """Upsert a draft candidate row by (user_id, image_id). Used by both
    record_batch (live generation) and studio_007_local_import.

    PR S3+ C8 invariant: `storage_key` must be non-empty — same reason
    as studio_result_repo.upsert. Without it `_serialize` emits
    path="" / url="" and the frontend renders a broken card the user
    can't recover.
    """
    if not storage_key:
        raise ValueError(
            f"upsert_candidate: storage_key is required (image_id={image_id})"
        )
    doc_set = {
        "user_id": user_id,
        "image_id": image_id,
        "step": step,
        "storage_key": storage_key,
        "status": "draft",
        "batch_id": batch_id,
        "is_prev_selected": False,
    }
    if extra:
        doc_set.update(extra)
    await _coll().update_one(
        {"user_id": user_id, "image_id": image_id},
        {"$set": doc_set,
         "$setOnInsert": {"generated_at": _now(), "video_ids": []}},
        upsert=True,
    )


async def record_batch(
    user_id: str,
    step: str,
    image_paths: Iterable[str],
    batch_id: str,
    *,
    extra_per_path: Optional[dict[str, dict]] = None,
) -> None:
    """Tag freshly generated candidates as draft + batch_id. Idempotent.

    image_paths are absolute disk paths from the generator. They are
    converted to storage_keys via media_store.key_from_path. extra_per_path,
    if given, maps abs_path → extra fields (model, prompt, seed, ...) to
    persist alongside the row.
    """
    for p in image_paths:
        key = storage_module.media_store.key_from_path(p)
        image_id = _image_id_from_path(p)
        extra = (extra_per_path or {}).get(p)
        await upsert_candidate(
            user_id, image_id=image_id, step=step,
            storage_key=key, batch_id=batch_id, extra=extra,
        )


async def cleanup_after_generate(user_id: str, step: str, current_batch_id: str) -> None:
    """Run AFTER record_batch for a fresh generation:
      - prev selected (status='selected' at moment of regen) → demote to
        draft + is_prev_selected=True
      - any pre-existing is_prev_selected marker (≠ the just-demoted) → delete
      - any draft from a non-current batch → delete
    Committed images are never touched.
    """
    pre_selected = None
    pre_prev = None
    stale_drafts: list[dict] = []

    cursor = _coll().find({"user_id": user_id, "step": step,
                            "status": {"$in": ["selected", "draft"]}})
    async for doc in cursor:
        if doc["status"] == "selected":
            pre_selected = doc
        elif doc["status"] == "draft":
            if doc.get("is_prev_selected"):
                pre_prev = doc
            elif doc.get("batch_id") != current_batch_id:
                stale_drafts.append(doc)

    # 1. Demote previous selected → draft + is_prev_selected=True
    if pre_selected is not None:
        await _coll().update_one(
            {"_id": pre_selected["_id"]},
            {"$set": {"status": "draft", "is_prev_selected": True},
             "$unset": {"selected_at": ""}},
        )
        # If a different prev marker was around, evict it.
        if pre_prev is not None and pre_prev["_id"] != pre_selected["_id"]:
            await _delete_row_and_file(pre_prev)
            pre_prev = None

    # 2. Delete stale drafts (orphans from previous batches)
    for doc in stale_drafts:
        await _delete_row_and_file(doc)


async def select(user_id: str, step: str, image_id: str) -> dict:
    """User picks `image_id`. Promotes target → selected, demotes any other
    selected to draft (decision #11: clear-then-set, with a single retry
    on the partial-unique-index race).

    Raises:
      LookupError        if image_id doesn't exist for this user/step
      ValueError         if the target is already committed
    """
    target = await _coll().find_one({"user_id": user_id, "step": step, "image_id": image_id})
    if target is None:
        raise LookupError(f"image {image_id!r} not found for user_id={user_id!r}, step={step!r}")
    if target.get("status") == "committed":
        raise ValueError(f"image {image_id!r} is committed; cannot re-select")

    # 1. Demote any existing selected (≠ target).
    await _coll().update_many(
        {"user_id": user_id, "step": step, "status": "selected",
         "image_id": {"$ne": image_id}},
        {"$set": {"status": "draft"}, "$unset": {"selected_at": ""}},
    )

    # 2. Promote target.
    try:
        updated = await _coll().find_one_and_update(
            {"user_id": user_id, "image_id": image_id},
            {"$set": {"status": "selected", "selected_at": _now()}},
            return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError:
        # Race: a concurrent select() for the same step. Retry once after
        # re-running the demote step. If it fails again, surface the error.
        await _coll().update_many(
            {"user_id": user_id, "step": step, "status": "selected",
             "image_id": {"$ne": image_id}},
            {"$set": {"status": "draft"}, "$unset": {"selected_at": ""}},
        )
        updated = await _coll().find_one_and_update(
            {"user_id": user_id, "image_id": image_id},
            {"$set": {"status": "selected", "selected_at": _now()}},
            return_document=ReturnDocument.AFTER,
        )
    return _serialize(updated)


async def commit(user_id: str, step: str, video_id: str) -> Optional[str]:
    """selected → committed, append video_id, delete every other non-committed.

    Returns image_id of the committed row, or None if nothing was selected.
    Idempotent if called twice for the same video_id (video_ids stays deduped).
    """
    selected = await _coll().find_one({"user_id": user_id, "step": step, "status": "selected"})
    if selected is None:
        logger.info("commit(%s, %s): no selected image for user=%s, nothing to commit",
                    step, video_id, user_id)
        return None

    video_ids = list(selected.get("video_ids") or [])
    if video_id not in video_ids:
        video_ids.append(video_id)
    await _coll().update_one(
        {"_id": selected["_id"]},
        {"$set": {
            "status": "committed",
            "is_prev_selected": False,
            "video_ids": video_ids,
            "committed_at": selected.get("committed_at") or _now(),
        }, "$unset": {"selected_at": ""}},
    )

    # Delete every other non-committed row (and its file) for this user/step.
    cursor = _coll().find({"user_id": user_id, "step": step,
                            "status": {"$ne": "committed"},
                            "image_id": {"$ne": selected["image_id"]}})
    async for doc in cursor:
        await _delete_row_and_file(doc)

    return selected["image_id"]


async def delete_candidate(user_id: str, step: str, image_id: str) -> str:
    """Remove a non-committed candidate. Returns:
      "deleted"   — row + file removed
      "not_found" — no doc matched
      "committed" — refused; caller should delete via the parent video
    """
    doc = await _coll().find_one({"user_id": user_id, "step": step, "image_id": image_id})
    if doc is None:
        return "not_found"
    if doc.get("status") == "committed":
        return "committed"
    await _delete_row_and_file(doc)
    return "deleted"


async def cascade_delete_by_video(user_id: str, video_id: str) -> list[str]:
    """When a video is deleted, drop its reference from each committed
    image. If video_ids becomes empty → delete the row and its file.

    Returns the list of image_ids that were physically removed.
    """
    removed: list[str] = []
    cursor = _coll().find({"user_id": user_id, "status": "committed",
                            "video_ids": video_id})
    async for doc in cursor:
        vids = [v for v in (doc.get("video_ids") or []) if v != video_id]
        if not vids:
            await _delete_row_and_file(doc)
            removed.append(doc["image_id"])
        else:
            await _coll().update_one({"_id": doc["_id"]},
                                       {"$set": {"video_ids": vids}})
    return removed


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _image_id_from_path(path: str) -> str:
    """Stable image_id from an absolute path (filename stem without `.png`)."""
    import os
    name = os.path.basename(path)
    if name.endswith(".png"):
        name = name[:-4]
    return name


async def _delete_row_and_file(doc: dict) -> None:
    """Delete the studio_hosts row AND its backing file. Best-effort on file."""
    key = doc.get("storage_key")
    if key:
        try:
            storage_module.media_store.delete(key)
        except (ValueError, OSError) as e:
            logger.warning("file delete failed for key=%s: %s", key, e)
    await _coll().delete_one({"_id": doc["_id"]})
