"""elevenlabs_voices collection — per-user mapping of cloned ElevenLabs voices.

Without this mapping, /api/elevenlabs/voices returns the entire workspace's
voices to every authenticated user, leaking other users' clones into the Step 3
"내 클론 목소리" picker.

Schema:
    {
      _id, user_id, voice_id, name, description, preview_url, labels,
      category="cloned", created_at, last_used_at,
    }

`voice_id` is unique across the collection (single ElevenLabs ID can't belong
to two of our users). Stock/premade voices are not stored here — they come
from ElevenLabs.list_voices() through the in-process stock cache.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from modules import db as db_module


def _coll():
    return db_module.get_db().elevenlabs_voices


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _public(doc: dict) -> dict:
    """API-shape projection. Mirrors the fields VoicePicker reads."""
    out: dict[str, Any] = {
        "voice_id": doc["voice_id"],
        "name": doc.get("name", ""),
        "category": doc.get("category", "cloned"),
        "preview_url": doc.get("preview_url", ""),
        "labels": doc.get("labels", {}),
    }
    if doc.get("description"):
        out["description"] = doc["description"]
    return out


async def add(
    user_id: str,
    *,
    voice_id: str,
    name: str,
    description: str = "",
    preview_url: str = "",
    labels: Optional[dict] = None,
    category: str = "cloned",
) -> dict:
    """Persist a voice for a user. Idempotent on (voice_id) — re-call with
    the same voice_id refreshes name/description/labels and preserves
    created_at.

    Ownership note: `$set` includes `user_id`, so calling add() with the
    same voice_id from a different user_id transfers the row (see
    test_voice_id_unique_across_users). In practice this is unreachable
    because ElevenLabs assigns globally unique voice_ids per clone — our
    users never share a voice_id. The unique index on voice_id enforces
    the invariant.
    """
    update = {
        "user_id": user_id,
        "voice_id": voice_id,
        "name": name,
        "description": description,
        "preview_url": preview_url,
        "labels": labels or {},
        "category": category,
    }
    await _coll().update_one(
        {"voice_id": voice_id},
        {"$set": update, "$setOnInsert": {"created_at": _now(), "last_used_at": None}},
        upsert=True,
    )
    doc = await _coll().find_one({"voice_id": voice_id})
    return _public(doc)


async def list_for_user(user_id: str) -> list[dict]:
    """Return the user's cloned voices, newest first."""
    cursor = _coll().find({"user_id": user_id}).sort("created_at", -1)
    return [_public(d) async for d in cursor]


async def is_owner(user_id: str, voice_id: str) -> bool:
    """True iff `user_id` cloned `voice_id`. False for unknown voice_ids
    (404-leak prevention happens at the endpoint layer)."""
    doc = await _coll().find_one(
        {"voice_id": voice_id, "user_id": user_id},
        {"_id": 1},
    )
    return doc is not None


async def get_owner(voice_id: str) -> Optional[str]:
    """Return owning user_id for diagnostics / admin tools. None if unknown."""
    doc = await _coll().find_one({"voice_id": voice_id}, {"user_id": 1})
    return doc.get("user_id") if doc else None


async def delete(user_id: str, voice_id: str) -> bool:
    """Delete iff the user owns the voice. Returns False on miss/foreign."""
    result = await _coll().delete_one({"voice_id": voice_id, "user_id": user_id})
    return result.deleted_count > 0


async def touch_last_used(user_id: str, voice_id: str) -> None:
    """Best-effort timestamp update after a successful generate. Failures
    here do not break generation (the audio is already produced)."""
    try:
        await _coll().update_one(
            {"voice_id": voice_id, "user_id": user_id},
            {"$set": {"last_used_at": _now()}},
        )
    except Exception:
        pass
