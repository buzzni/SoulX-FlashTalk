"""Import legacy on-disk host artifacts into studio_hosts / studio_saved_hosts.

This is the PR4 portion of studio_007. The PR5 portion (results manifests
→ studio_results) is added separately.

Per plan §8.3 + decision #13:
- NO outer "skip if migration name exists" guard. Per-record upsert by
  natural key (image_id / host_id) makes re-runs safe.
- studio_migrations row is appended at the end as an audit trail; running
  twice yields two rows.

Per codex finding #N4: pre-scan candidate hosts and demote any "selected"
duplicates to "draft" before the upsert, otherwise the partial-unique
index `one_selected_per_step` rejects the second writer.

Usage:
    .venv/bin/python scripts/studio_007_local_import.py \\
        --owner jack --dry-run
    .venv/bin/python scripts/studio_007_local_import.py \\
        --owner jack --commit
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Iterable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv
from pymongo import MongoClient

import config  # noqa: E402  (import after sys.path adjustment)
from scripts._lib import assert_local_only, record_migration

logger = logging.getLogger("studio_007")
logging.basicConfig(level=logging.INFO, format="%(message)s")


load_dotenv()
DEFAULT_MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DEFAULT_DB_NAME = os.environ.get("DB_NAME", "ai_showhost")


# ── Path / key helpers ───────────────────────────────────────────────

def _bucket_dirs() -> dict[str, str]:
    return {
        "outputs":  os.path.realpath(config.OUTPUTS_DIR),
        "uploads":  os.path.realpath(config.UPLOADS_DIR),
        "examples": os.path.realpath(config.EXAMPLES_DIR),
    }


# Symlinked variants the project picks up — strip these prefixes too.
_SYMLINK_PREFIXES = (
    "/opt/home/justin/workspace/SoulX-FlashTalk",
    "/opt/home/jack/workspace/SoulX-FlashTalk",
)


def _key_from_path(path: str) -> Optional[str]:
    """Convert an absolute path (possibly through a symlink) to a
    bucket-prefixed storage_key, or None if the path doesn't live in any
    known bucket dir.
    """
    if not path:
        return None
    target = os.path.realpath(path)
    for bucket, root in _bucket_dirs().items():
        rel: Optional[str] = None
        if target.startswith(root + os.sep):
            rel = target[len(root) + 1:]
        else:
            # also try the symlinked variants in case realpath was the
            # same source dir but config.OUTPUTS_DIR resolved to a
            # different name.
            for alt in _SYMLINK_PREFIXES:
                tail = root.replace(alt, "").lstrip(os.sep)
                if tail and target.endswith(os.sep + tail) and \
                   target.startswith(alt + os.sep):
                    rel = target[len(alt) + 1 + len(tail) + 1:]
                    break
        if rel:
            return f"{bucket}/{rel.replace(os.sep, '/')}"
    return None


def _scrub_paths(obj: Any) -> Any:
    """Recursively replace absolute filesystem paths with bucket-prefixed
    storage keys. Strings that don't look like a known absolute path are
    returned unchanged.
    """
    if isinstance(obj, str):
        if obj.startswith("/") and any(part in obj for part in (
                "/outputs/", "/uploads/", "/examples/")):
            key = _key_from_path(obj)
            return key or obj
        return obj
    if isinstance(obj, list):
        return [_scrub_paths(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _scrub_paths(v) for k, v in obj.items()}
    return obj


# ── Candidate hosts (host_*.png.meta.json + composite_*.png.meta.json) ──

def _list_candidate_metas() -> list[tuple[str, Path]]:
    """Return [(step, meta_path), ...] for every host_/composite_ sidecar."""
    out: list[tuple[str, Path]] = []
    hosts_dir = Path(config.OUTPUTS_DIR) / "hosts" / "saved"
    if hosts_dir.is_dir():
        for f in hosts_dir.iterdir():
            if f.name.startswith("host_") and f.name.endswith(".png.meta.json"):
                out.append(("1-host", f))
    comp_dir = Path(config.OUTPUTS_DIR) / "composites"
    if comp_dir.is_dir():
        for f in comp_dir.iterdir():
            if f.name.startswith("composite_") and f.name.endswith(".png.meta.json"):
                out.append(("2-composite", f))
    return out


def _read_meta(p: Path) -> dict:
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("  ! failed to parse %s: %s", p, e)
        return {}


def _candidate_doc(owner: str, step: str, meta_path: Path, meta: dict) -> Optional[dict]:
    """Build a studio_hosts row from a sidecar. Returns None on bad data."""
    image_path = str(meta_path)[: -len(".meta.json")]  # strip the ".meta.json"
    storage_key = _key_from_path(image_path)
    if not storage_key:
        logger.warning("  ! no bucket for %s — skipping", image_path)
        return None

    image_id = meta.get("image_id") or Path(image_path).stem
    status = meta.get("status") or "committed"  # untracked → committed (lifecycle's behavior)
    if status not in ("draft", "selected", "committed"):
        status = "committed"

    return {
        "user_id": owner,
        "image_id": image_id,
        "step": step,
        "storage_key": storage_key,
        "status": status,
        "batch_id": meta.get("batch_id"),
        "is_prev_selected": bool(meta.get("is_prev_selected")),
        "video_ids": meta.get("video_ids") or [],
        "model": meta.get("model"),
        "mode": meta.get("mode"),
        "prompt": meta.get("prompt"),
        "system_instruction": meta.get("system_instruction"),
        "seed": meta.get("seed"),
        "temperature": meta.get("temperature"),
        "face_strength": meta.get("face_strength"),
        "outfit_strength": meta.get("outfit_strength"),
        "has_face_ref": meta.get("has_face_ref"),
        "has_outfit_ref": meta.get("has_outfit_ref"),
        "has_style_ref": meta.get("has_style_ref"),
        "generated_at": meta.get("generated_iso") or meta.get("generated_at"),
        "committed_at": meta.get("committed_at"),
    }


def _enforce_at_most_one_selected(docs: list[dict]) -> int:
    """Codex N4: if multiple rows for the same (user_id, step) claim
    status='selected', demote all but the most-recently-committed/generated
    one to 'draft' BEFORE the upsert, so the partial-unique index doesn't
    reject the second writer.

    Returns the number of demotions applied.
    """
    by_step: dict[tuple[str, str], list[dict]] = {}
    for d in docs:
        if d["status"] == "selected":
            by_step.setdefault((d["user_id"], d["step"]), []).append(d)
    demoted = 0
    for (uid, step), group in by_step.items():
        if len(group) <= 1:
            continue

        def _key(x: dict) -> str:
            return str(x.get("committed_at") or x.get("generated_at") or "")
        keep = max(group, key=_key)
        for d in group:
            if d is keep:
                continue
            d["status"] = "draft"
            demoted += 1
        logger.warning("  · step=%s user=%s: %d 'selected' rows → kept %s, demoted %d",
                       step, uid, len(group), keep["image_id"], demoted)
    return demoted


def _upsert_candidates(db, docs: list[dict]) -> int:
    """Per-record upsert by (user_id, image_id). Returns number of rows touched."""
    n = 0
    for d in docs:
        db.studio_hosts.update_one(
            {"user_id": d["user_id"], "image_id": d["image_id"]},
            {"$set": d, "$setOnInsert": {"_imported_at": _utcnow()}},
            upsert=True,
        )
        n += 1
    return n


# ── Saved hosts (<uuid32>.json — sidecars without ".meta.json") ────────

def _list_saved_host_sidecars() -> list[Path]:
    hosts_dir = Path(config.OUTPUTS_DIR) / "hosts" / "saved"
    if not hosts_dir.is_dir():
        return []
    out: list[Path] = []
    for f in hosts_dir.iterdir():
        if (f.suffix == ".json"
                and not f.name.endswith(".meta.json")
                and not f.name.startswith("host_")
                and not f.name.startswith("composite_")):
            out.append(f)
    return out


def _saved_doc(owner: str, sidecar: Path, payload: dict) -> Optional[dict]:
    host_id = payload.get("id") or sidecar.stem
    image_path = payload.get("path") or str(sidecar.with_suffix(".png"))
    storage_key = _key_from_path(image_path)
    if not storage_key:
        logger.warning("  ! no bucket for saved-host image %s — skipping", image_path)
        return None
    return {
        "user_id": owner,
        "host_id": host_id,
        "name": payload.get("name", ""),
        "storage_key": storage_key,
        "meta": _scrub_paths(payload.get("meta")) if payload.get("meta") else None,
    }


def _upsert_saved(db, docs: list[dict]) -> int:
    n = 0
    now = _utcnow()
    for d in docs:
        set_doc = {k: v for k, v in d.items() if v is not None or k == "meta"}
        db.studio_saved_hosts.update_one(
            {"user_id": d["user_id"], "host_id": d["host_id"]},
            {"$set": set_doc, "$setOnInsert": {"created_at": now}},
            upsert=True,
        )
        n += 1
    return n


def _utcnow():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc)


# ── Main ────────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    grp = p.add_mutually_exclusive_group()
    grp.add_argument("--commit", action="store_true",
                     help="apply the import (default: dry-run)")
    grp.add_argument("--dry-run", action="store_true",
                     help="show counts only, write nothing (default)")
    p.add_argument("--owner", required=True,
                   help="user_id to attribute every imported row to")
    p.add_argument("--mongo-url", default=DEFAULT_MONGO_URL)
    p.add_argument("--db-name", default=DEFAULT_DB_NAME)
    return p.parse_args()


def main() -> int:
    args = _parse_args()
    assert_local_only(args.mongo_url, args.db_name)

    client = MongoClient(args.mongo_url, serverSelectionTimeoutMS=5000)
    client.admin.command("ping")
    db = client[args.db_name]

    metas = _list_candidate_metas()
    candidate_docs: list[dict] = []
    skipped_meta = 0
    for step, p in metas:
        meta = _read_meta(p)
        if not meta:
            skipped_meta += 1
            continue
        doc = _candidate_doc(args.owner, step, p, meta)
        if doc is None:
            skipped_meta += 1
            continue
        candidate_docs.append(doc)

    saved_payloads = []
    skipped_saved = 0
    for sidecar in _list_saved_host_sidecars():
        try:
            with open(sidecar, "r", encoding="utf-8") as fh:
                payload = json.load(fh)
        except (OSError, json.JSONDecodeError) as e:
            logger.warning("  ! failed to parse %s: %s", sidecar, e)
            skipped_saved += 1
            continue
        doc = _saved_doc(args.owner, sidecar, payload)
        if doc is None:
            skipped_saved += 1
            continue
        saved_payloads.append(doc)

    demoted = _enforce_at_most_one_selected(candidate_docs)

    mode = "COMMIT" if args.commit else "DRY-RUN"
    logger.info("=== studio_007_local_import [%s] ===", mode)
    logger.info("  target:                 %s / %s", args.mongo_url, args.db_name)
    logger.info("  owner:                  %s", args.owner)
    logger.info("  candidate metas found:  %d (skipped: %d)", len(metas), skipped_meta)
    logger.info("    by step:")
    by_step: dict[str, int] = {}
    for d in candidate_docs:
        by_step[d["step"]] = by_step.get(d["step"], 0) + 1
    for step, n in sorted(by_step.items()):
        logger.info("      %s : %d", step, n)
    logger.info("  saved-host sidecars:    %d (skipped: %d)", len(saved_payloads), skipped_saved)
    logger.info("  selected demotions:     %d", demoted)

    if not args.commit:
        logger.info("\n  --dry-run: no writes. Re-run with --commit to apply.")
        return 0

    n_hosts = _upsert_candidates(db, candidate_docs)
    n_saved = _upsert_saved(db, saved_payloads)
    summary = (
        f"hosts={n_hosts} saved={n_saved} demoted={demoted} "
        f"skipped_meta={skipped_meta} skipped_saved={skipped_saved}"
    )
    record_migration(db, "studio_007_local_import_hosts", summary)
    logger.info("\n  ✓ committed. %s", summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
