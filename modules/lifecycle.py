"""Image lifecycle management for Step1 (host) and Step2 (composite) candidates.

Operates on the existing per-image `<image>.png.meta.json` sidecars written by
`write_generation_metadata` (modules/image_compositor.py). Adds lifecycle
fields without disturbing the diagnostic fields already present.

State model
-----------
    status: 'draft' | 'selected' | 'committed'
    is_prev_selected: bool        # marks the "revert target" tile (only meaningful while not committed)
    batch_id: str                 # groups candidates from one generation
    video_ids: list[str]          # populated on commit; appended on subsequent commits
    selected_at, committed_at: ISO timestamps

Per step (host | composite) at any given moment:
  - at most 1 image with status='selected'
  - at most 1 image with is_prev_selected=True (the 5th "previous selection" tile)
  - 0..N images with status='draft' (typically 0 or 4 from the latest batch + maybe 1 prev_selected marker)
  - 0..N images with status='committed' (permanent, tied to one or more rendered videos)

Transitions
-----------
  generate (success):
    record_batch → mark new candidates draft, batch_id set
    cleanup_after_generate → demote current selected to is_prev_selected (status stays draft);
                             delete old is_prev_selected marker; delete old non-current drafts

  select(image_id):
    target → status='selected'
    other selected (≠ target) → status='draft'    (is_prev_selected unchanged)

  commit(step, video_id):
    selected → status='committed', append video_id, clear is_prev_selected
    everything else non-committed → deleted

  cascade_delete_by_video(video_id):
    removes video_id from each committed image; if video_ids becomes empty → delete the image
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from typing import Dict, List, Literal, Optional, TypedDict

import config

logger = logging.getLogger(__name__)

Step = Literal["host", "composite"]
Status = Literal["draft", "selected", "committed"]

# Step → directory + filename prefix that distinguishes generate-candidates
# from other artifacts living in the same directory (e.g., HOSTS_DIR also
# holds explicit "saved hosts" with `<uuid32>.png` naming, which are managed
# by /api/hosts CRUD and out of scope for lifecycle).
_COMPOSITES_DIR = os.path.join(config.OUTPUTS_DIR, "composites")

STEP_DIRS: Dict[Step, str] = {
    "host": config.HOSTS_DIR,
    "composite": _COMPOSITES_DIR,
}

# Candidate filename prefix per step. Saved hosts (`<uuid32>.png`) are
# excluded by this prefix check.
STEP_PREFIX: Dict[Step, str] = {
    "host": "host_",
    "composite": "composite_",
}


class ImageRecord(TypedDict, total=False):
    image_id: str
    path: str
    meta: dict


# ---------------------------------------------------------------------------
# Sidecar I/O
# ---------------------------------------------------------------------------

def _meta_path(image_path: str) -> str:
    return image_path + ".meta.json"


def _read_meta(image_path: str) -> dict:
    p = _meta_path(image_path)
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("Failed to read sidecar %s: %s", p, e)
        return {}


def _write_meta(image_path: str, meta: dict) -> None:
    """Atomic write: tmp file + os.replace."""
    p = _meta_path(image_path)
    tmp = p + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2, default=str)
        os.replace(tmp, p)
    except OSError as e:
        logger.error("Failed to write sidecar %s: %s", p, e)
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def _image_id(image_path: str) -> str:
    """Stable ID derived from filename (without `.png` extension)."""
    name = os.path.basename(image_path)
    if name.endswith(".png"):
        name = name[:-4]
    return name


def _delete_image(image_path: str) -> None:
    """Remove the PNG and its sidecar; log but do not raise on failure."""
    for p in (image_path, _meta_path(image_path)):
        try:
            os.unlink(p)
        except FileNotFoundError:
            pass
        except OSError as e:
            logger.warning("Failed to delete %s: %s", p, e)


# ---------------------------------------------------------------------------
# Listing / state queries
# ---------------------------------------------------------------------------

def serialize_record(rec: Optional[ImageRecord]) -> Optional[dict]:
    """Reduce an internal ImageRecord to the minimal shape the frontend
    needs (path, url, image_id, batch_id, is_prev_selected). Returns None
    for None input. URL convention matches the existing /api/files mount."""
    if rec is None:
        return None
    path = rec["path"]
    meta = rec.get("meta", {}) or {}
    rel = os.path.relpath(path, config.OUTPUTS_DIR)
    return {
        "image_id": rec["image_id"],
        "path": path,
        "url": f"/api/files/{rel}",
        "batch_id": meta.get("batch_id"),
        "is_prev_selected": bool(meta.get("is_prev_selected")),
        "seed": meta.get("seed"),
    }


def _list_candidate_paths(step: Step) -> List[str]:
    d = STEP_DIRS[step]
    prefix = STEP_PREFIX[step]
    if not os.path.isdir(d):
        return []
    return [
        os.path.join(d, f)
        for f in os.listdir(d)
        if f.startswith(prefix) and f.endswith(".png")
    ]


def _resolve_image_path(step: Step, image_id: str) -> Optional[str]:
    """Map an image_id back to its absolute PNG path. Defensive against
    path traversal — image_id must not contain separators."""
    if "/" in image_id or "\\" in image_id or ".." in image_id:
        return None
    candidate = os.path.join(STEP_DIRS[step], image_id + ".png")
    return candidate if os.path.exists(candidate) else None


def get_state(step: Step) -> Dict[str, Optional[ImageRecord] | List[ImageRecord]]:
    """Return current lifecycle state for a step.

    Shape:
      {
        "selected": ImageRecord | None,
        "prev_selected": ImageRecord | None,   # tile with is_prev_selected=True
        "drafts": list[ImageRecord],            # excludes prev_selected tile
        "committed": list[ImageRecord],
      }
    """
    selected: Optional[ImageRecord] = None
    prev_selected: Optional[ImageRecord] = None
    drafts: List[ImageRecord] = []
    committed: List[ImageRecord] = []

    for path in _list_candidate_paths(step):
        meta = _read_meta(path)
        rec: ImageRecord = {"image_id": _image_id(path), "path": path, "meta": meta}
        status = meta.get("status", "committed")  # untracked → committed (orphan)

        if status == "selected":
            selected = rec
        elif status == "committed":
            committed.append(rec)
        elif status == "draft":
            if meta.get("is_prev_selected"):
                prev_selected = rec
            else:
                drafts.append(rec)
        # Unknown statuses are ignored (treated as untouchable)

    # If "selected" image is also the prev_selected marker, keep it as
    # `selected` and surface it again in `prev_selected` so the UI can
    # render the 5th "previous selection" tile in the proper slot.
    if selected and selected["meta"].get("is_prev_selected") and prev_selected is None:
        prev_selected = selected

    return {
        "selected": selected,
        "prev_selected": prev_selected,
        "drafts": drafts,
        "committed": committed,
    }


# ---------------------------------------------------------------------------
# State transitions
# ---------------------------------------------------------------------------

def new_batch_id() -> str:
    return f"batch_{uuid.uuid4().hex[:8]}"


def record_batch(step: Step, image_paths: List[str], batch_id: str) -> None:
    """Tag freshly generated candidates as draft + batch_id. Idempotent —
    extends existing sidecars rather than overwriting diagnostic fields."""
    for p in image_paths:
        meta = _read_meta(p)
        meta.update({
            "image_id": _image_id(p),
            "batch_id": batch_id,
            "status": "draft",
            "is_prev_selected": False,
            "video_ids": meta.get("video_ids", []),
        })
        _write_meta(p, meta)


def cleanup_after_generate(step: Step, current_batch_id: str) -> None:
    """Run AFTER record_batch for a fresh generation. Implements the rule:
      - prev selected (status=selected at moment of regen) → demote to draft + is_prev_selected=True
      - any pre-existing is_prev_selected marker (≠ the just-demoted) → delete
      - any draft from a non-current batch → delete (orphans from before)
    Committed images are never touched here.
    """
    state_paths = _list_candidate_paths(step)

    pre_selected_path: Optional[str] = None
    pre_prev_path: Optional[str] = None
    stale_drafts: List[str] = []

    for p in state_paths:
        meta = _read_meta(p)
        status = meta.get("status")
        bid = meta.get("batch_id")

        if status == "committed":
            continue

        if status == "selected":
            pre_selected_path = p
            continue

        if status == "draft":
            if meta.get("is_prev_selected"):
                pre_prev_path = p
            elif bid != current_batch_id:
                stale_drafts.append(p)

    # 1. Demote previous selected → draft + is_prev_selected=True
    if pre_selected_path:
        meta = _read_meta(pre_selected_path)
        meta["status"] = "draft"
        meta["is_prev_selected"] = True
        meta.pop("selected_at", None)
        _write_meta(pre_selected_path, meta)
        # The just-promoted image takes the prev slot; if there was a prior
        # prev marker that's a different image, evict it.
        if pre_prev_path and pre_prev_path != pre_selected_path:
            _delete_image(pre_prev_path)
            pre_prev_path = None
    # else: no current selection → keep existing prev marker as-is.

    # 2. Delete stale drafts (orphans from previous batches that were not selected)
    for p in stale_drafts:
        _delete_image(p)


def select(step: Step, image_id: str) -> ImageRecord:
    """User picks `image_id`. Returns the new state record for the picked image.
    Raises FileNotFoundError / ValueError on bad input."""
    target = _resolve_image_path(step, image_id)
    if target is None:
        raise FileNotFoundError(f"Image not found for step={step}, id={image_id}")

    target_meta = _read_meta(target)
    if target_meta.get("status") == "committed":
        raise ValueError(f"Image {image_id} is committed; cannot re-select")

    # Demote any other selected (only one allowed)
    for p in _list_candidate_paths(step):
        if p == target:
            continue
        m = _read_meta(p)
        if m.get("status") == "selected":
            m["status"] = "draft"
            m.pop("selected_at", None)
            _write_meta(p, m)

    # Promote target
    target_meta["status"] = "selected"
    target_meta["selected_at"] = _now_iso()
    _write_meta(target, target_meta)
    return {"image_id": image_id, "path": target, "meta": target_meta}


def commit(step: Step, video_id: str) -> Optional[str]:
    """On final video generation success, mark the step's currently-selected
    image as committed (linked to video_id) and delete every other
    non-committed image in this step. Idempotent if called twice for the
    same video_id (video_ids stays deduped).

    Returns the path of the committed image, or None if nothing was
    selected at commit time (no-op)."""
    selected_path: Optional[str] = None
    others_to_delete: List[str] = []

    for p in _list_candidate_paths(step):
        meta = _read_meta(p)
        status = meta.get("status")
        if status == "selected":
            selected_path = p
        elif status == "draft":
            others_to_delete.append(p)
        # committed: leave alone

    if selected_path is None:
        logger.info("commit(%s, %s): no selected image, nothing to commit", step, video_id)
        return None

    meta = _read_meta(selected_path)
    video_ids = list(meta.get("video_ids", []))
    if video_id not in video_ids:
        video_ids.append(video_id)
    meta.update({
        "status": "committed",
        "is_prev_selected": False,
        "video_ids": video_ids,
        "committed_at": meta.get("committed_at") or _now_iso(),
    })
    _write_meta(selected_path, meta)

    for p in others_to_delete:
        _delete_image(p)

    return selected_path


def delete_candidate(step: Step, image_id: str) -> str:
    """Remove a non-committed candidate. Returns one of:
      "deleted"   — image+sidecar removed
      "not_found" — no file matched image_id
      "committed" — refused; caller should delete via the parent video
    """
    path = _resolve_image_path(step, image_id)
    if path is None:
        return "not_found"
    if _read_meta(path).get("status") == "committed":
        return "committed"
    _delete_image(path)
    return "deleted"


def cascade_delete_by_video(video_id: str) -> List[str]:
    """When a video is deleted, drop its reference from each committed image.
    Images whose video_ids becomes empty are deleted (orphan prevention).

    Returns the list of image paths that were physically removed."""
    removed: List[str] = []
    for step in ("host", "composite"):
        for p in _list_candidate_paths(step):  # type: ignore[arg-type]
            meta = _read_meta(p)
            if meta.get("status") != "committed":
                continue
            vids = list(meta.get("video_ids", []))
            if video_id not in vids:
                continue
            vids = [v for v in vids if v != video_id]
            if not vids:
                _delete_image(p)
                removed.append(p)
            else:
                meta["video_ids"] = vids
                _write_meta(p, meta)
    return removed


# ---------------------------------------------------------------------------
# Migration helper (used by scripts/migrate_lifecycle.py)
# ---------------------------------------------------------------------------

def migrate_existing_to_committed(step: Step) -> Dict[str, int]:
    """Treat every pre-existing candidate as a committed orphan
    (video_ids=[], no batch_id). Idempotent. Creates a sidecar if missing.

    Returns counts: {touched, already_tracked, sidecar_created}."""
    touched = 0
    already = 0
    created = 0
    for p in _list_candidate_paths(step):
        meta = _read_meta(p)
        if not meta:
            # No sidecar — synthesize a minimal one.
            meta = {}
            created += 1
        if "status" in meta and meta["status"] in ("draft", "selected", "committed"):
            already += 1
            continue
        meta.update({
            "image_id": _image_id(p),
            "status": "committed",
            "is_prev_selected": False,
            "batch_id": meta.get("batch_id"),  # may be None for legacy files
            "video_ids": meta.get("video_ids", []),
            "committed_at": meta.get("committed_at") or _now_iso(),
            "migrated": True,
        })
        _write_meta(p, meta)
        touched += 1
    return {"touched": touched, "already_tracked": already, "sidecar_created": created}
