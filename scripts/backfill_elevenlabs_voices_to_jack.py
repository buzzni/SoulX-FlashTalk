"""One-shot: assign every existing ElevenLabs cloned voice in the workspace
to a single owner in our DB.

Why: before this fix, /api/elevenlabs/voices returned the entire workspace
to every authenticated user. After the fix, the endpoint reads from
elevenlabs_voices (user_id → voice_id mapping) and only returns voices
the requesting user owns. So every voice that was cloned before the
mapping existed is currently invisible to all users — this script fixes
that by recording (BACKFILL_OWNER_USER_ID, voice_id, …) for each cloned
workspace voice.

Stock voices (premade/professional) are skipped — they're shared assets
served via the in-process stock cache, not user-owned.

Usage:
    python -m scripts.backfill_elevenlabs_voices_to_jack
    BACKFILL_OWNER_USER_ID=alice python -m scripts.backfill_elevenlabs_voices_to_jack

Idempotent: re-runs upsert into the same row, so running twice is safe.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path

# Allow running as `python scripts/backfill_…py` (not just -m).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config
from modules import db as db_module
from modules.elevenlabs_tts import ElevenLabsTTS
from modules.repositories import elevenlabs_voice_repo

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("backfill_elevenlabs_voices")


async def _run() -> int:
    if not config.ELEVENLABS_API_KEY:
        logger.error("ELEVENLABS_API_KEY not configured — abort")
        return 1

    owner = os.environ.get("BACKFILL_OWNER_USER_ID", "jack")
    logger.info("backfilling cloned ElevenLabs voices to user_id=%s", owner)

    await db_module.init()
    try:
        tts = ElevenLabsTTS(api_key=config.ELEVENLABS_API_KEY)
        all_voices = await asyncio.get_event_loop().run_in_executor(None, tts.list_voices)

        cloned = [v for v in all_voices if v.get("category") == "cloned"]
        logger.info("found %d total voices, %d cloned", len(all_voices), len(cloned))

        added = 0
        for v in cloned:
            voice_id = v.get("voice_id")
            if not voice_id:
                continue
            await elevenlabs_voice_repo.add(
                owner,
                voice_id=voice_id,
                name=v.get("name", "") or "",
                description=v.get("description", "") or "",
                preview_url=v.get("preview_url", "") or "",
                labels=v.get("labels") or {},
                category="cloned",
            )
            added += 1
            logger.info("  ✔ %s (%s)", voice_id, v.get("name"))

        logger.info("done: %d voices mapped to user_id=%s", added, owner)
        return 0
    finally:
        await db_module.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(_run()))
