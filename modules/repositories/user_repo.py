"""Read-only access to the shared `users` collection.

Studio never writes to users except via `auth.logout()` which bumps
`studio_token_version`. Everything else here is read.
"""
from __future__ import annotations

from typing import Any, Optional

from pymongo import ReturnDocument

from modules import db as db_module


async def find_by_id(user_id: str) -> Optional[dict[str, Any]]:
    return await db_module.get_db().users.find_one({"user_id": user_id})


async def has_subscription(user_id: str, name: str) -> bool:
    """True iff `users.subscriptions` array contains `name`."""
    doc = await db_module.get_db().users.find_one(
        {"user_id": user_id, "subscriptions": name},
        projection={"_id": 1},
    )
    return doc is not None


async def bump_studio_token_version(user_id: str) -> int:
    """Invalidate all outstanding studio JWTs for this user. Returns the new version.

    Used by `auth.logout()`. Never touches platform's `token_version`.
    """
    doc = await db_module.get_db().users.find_one_and_update(
        {"user_id": user_id},
        {"$inc": {"studio_token_version": 1}},
        projection={"studio_token_version": 1, "_id": 0},
        return_document=ReturnDocument.AFTER,
    )
    if doc is None:
        raise LookupError(f"no user with user_id={user_id!r}")
    return int(doc["studio_token_version"])
