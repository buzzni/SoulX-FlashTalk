"""Async motor client + index initialization for studio_* collections.

The client is a process-wide singleton. FastAPI's startup hook calls init();
shutdown calls close(). Repositories import `get_db()` and call its methods.

Indexes (per docs/db-integration-plan.md §4 + §7, docs/playlist-feature-plan.md §3):
- studio_hosts:        {user_id, image_id} unique;
                        {user_id, step, status, generated_at} compound;
                        {user_id, batch_id};
                        partial unique {user_id, step} where status="selected"
- studio_saved_hosts:  {user_id, host_id} unique;
                        {user_id, created_at}
- studio_results:      {user_id, task_id} unique;
                        {user_id, status, completed_at};
                        {user_id, playlist_id, completed_at} compound (filter)
- studio_playlists:    {user_id, playlist_id} unique;
                        {user_id, name_normalized} unique

Re-running init_indexes() is a no-op on collections that already have the
spec — motor's create_index uses the same idempotent semantics as pymongo.
"""
from __future__ import annotations

import logging
from typing import Optional

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

import config

logger = logging.getLogger(__name__)


_client: Optional[AsyncIOMotorClient] = None
_db: Optional[AsyncIOMotorDatabase] = None


def get_db() -> AsyncIOMotorDatabase:
    if _db is None:
        raise RuntimeError("db.init() has not been called yet")
    return _db


async def init() -> None:
    """Connect to MongoDB and verify reachability with a ping.

    Fail-fast: if mongod is unreachable, this raises and the FastAPI startup
    hook propagates the error so uvicorn refuses to bind. (Per plan
    decision #15 — no degraded-mode middleware.)
    """
    global _client, _db
    if _client is not None:
        return
    _client = AsyncIOMotorClient(
        config.MONGO_URL,
        serverSelectionTimeoutMS=5000,
        maxPoolSize=50,
        retryWrites=True,
    )
    await _client.admin.command("ping")
    _db = _client[config.DB_NAME]
    await init_indexes()
    logger.info("db: connected to %s/%s; indexes initialized",
                _client.address, config.DB_NAME)


async def init_indexes() -> None:
    db = get_db()
    # studio_hosts (candidate avatars under lifecycle state machine)
    await db.studio_hosts.create_index(
        [("user_id", 1), ("image_id", 1)], unique=True, name="user_image_uniq"
    )
    await db.studio_hosts.create_index(
        [("user_id", 1), ("step", 1), ("status", 1), ("generated_at", -1)],
        name="user_step_status_gen",
    )
    await db.studio_hosts.create_index(
        [("user_id", 1), ("batch_id", 1)], name="user_batch"
    )
    # Plan decision #11: enforce "at most one selected per (user_id, step)" at the
    # DB layer so concurrent select() calls fail-fast on the second writer.
    await db.studio_hosts.create_index(
        [("user_id", 1), ("step", 1)],
        unique=True,
        partialFilterExpression={"status": "selected"},
        name="one_selected_per_step",
    )
    # studio_saved_hosts (user library)
    await db.studio_saved_hosts.create_index(
        [("user_id", 1), ("host_id", 1)], unique=True, name="user_host_uniq"
    )
    await db.studio_saved_hosts.create_index(
        [("user_id", 1), ("created_at", -1)], name="user_created"
    )
    # studio_results (generation results)
    await db.studio_results.create_index(
        [("user_id", 1), ("task_id", 1)], unique=True, name="user_task_uniq"
    )
    await db.studio_results.create_index(
        [("user_id", 1), ("status", 1), ("completed_at", -1)],
        name="user_status_completed",
    )
    # Latest sort across all statuses — decision #19 in
    # docs/results-page-overhaul-plan.md. Serves
    # `find({user_id, status: {$in: [...]}}).sort(completed_at)` without
    # bucket merge. All terminal rows guaranteed to have completed_at
    # set via persist_terminal_failure (decision #20).
    await db.studio_results.create_index(
        [("user_id", 1), ("completed_at", -1)],
        name="user_completed",
    )
    # Playlist filter index — see docs/playlist-feature-plan.md §3.
    await db.studio_results.create_index(
        [("user_id", 1), ("playlist_id", 1), ("completed_at", -1)],
        name="user_playlist_completed",
    )
    # Public-endpoint lookup for /api/videos/{task_id} (PR S3+ C11).
    # The handler queries by task_id alone (no user_id) because
    # <video> tags can't send Authorization headers, so it can't use
    # the user_task_uniq compound index. Without this dedicated
    # single-field index it would fall back to a collection scan.
    await db.studio_results.create_index(
        [("task_id", 1)],
        name="task_id_public_lookup",
    )
    # studio_playlists (per-user playlists)
    await db.studio_playlists.create_index(
        [("user_id", 1), ("playlist_id", 1)],
        unique=True,
        name="user_playlist_uniq",
    )
    await db.studio_playlists.create_index(
        [("user_id", 1), ("name_normalized", 1)],
        unique=True,
        name="user_name_normalized_uniq",
    )


async def close() -> None:
    global _client, _db
    if _client is not None:
        _client.close()
        _client = None
        _db = None
