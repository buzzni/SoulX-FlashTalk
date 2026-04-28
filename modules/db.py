"""Async motor client + index initialization for studio_* collections.

The client is a process-wide singleton. FastAPI's startup hook calls init();
shutdown calls close(). Repositories import `get_db()` and call its methods.

Indexes (per docs/db-integration-plan.md §4 + §7, docs/playlist-feature-plan.md §3,
docs/plans/streaming-resume-eng-spec.md §7):
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
- generation_jobs:     {user_id, kind, created_at desc} listing;
                        partial {state, heartbeat_at} where state="streaming";
                        partial {state, updated_at} where state in
                          ("ready","failed","cancelled");
                        partial unique {user_id, input_hash} where state in
                          ("pending","streaming")  -- dedupe-by-reuse

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
    # Playlist filter index — see docs/playlist-feature-plan.md §3.
    await db.studio_results.create_index(
        [("user_id", 1), ("playlist_id", 1), ("completed_at", -1)],
        name="user_playlist_completed",
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
    # generation_jobs (server-side first-class generation entity)
    # Eng-spec §7. partial filters scope each index to the lifecycle slice that
    # actually queries it, keeping write amplification low and dedupe correct.
    await db.generation_jobs.create_index(
        [("user_id", 1), ("kind", 1), ("created_at", -1)],
        name="user_kind_created",
    )
    # Sweep stuck streaming jobs (heartbeat older than threshold). JobRunner
    # commit will own the sweeper; the index is laid down here so the partial
    # is enforced from day one.
    await db.generation_jobs.create_index(
        [("state", 1), ("heartbeat_at", 1)],
        partialFilterExpression={"state": "streaming"},
        name="state_heartbeat_streaming",
    )
    # TTL sweep candidates (terminal jobs older than 7 days).
    await db.generation_jobs.create_index(
        [("state", 1), ("updated_at", 1)],
        partialFilterExpression={
            "state": {"$in": ["ready", "failed", "cancelled"]}
        },
        name="state_updated_terminal",
    )
    # Dedupe-by-reuse: any active job (pending|streaming) with the same
    # (user_id, input_hash) collapses onto the existing row. Terminal jobs
    # drop out of the partial filter, freeing the slot for a re-roll.
    await db.generation_jobs.create_index(
        [("user_id", 1), ("input_hash", 1)],
        unique=True,
        partialFilterExpression={
            "state": {"$in": ["pending", "streaming"]}
        },
        name="user_input_hash_active_uniq",
    )
    # Recovery scan at startup (mark_active_as_failed) filters by
    # state $in [pending, streaming]. The partial sweep / dedupe
    # indexes above don't satisfy that query as a leading column, so
    # without this index every cold start COLLSCANs the collection
    # while blocking uvicorn bind. Single-process invariant means the
    # write amplification of a non-partial state index is one extra
    # entry per insert/update — cheap.
    await db.generation_jobs.create_index(
        [("state", 1)],
        name="state_idx",
    )


async def close() -> None:
    global _client, _db
    if _client is not None:
        _client.close()
        _client = None
        _db = None
