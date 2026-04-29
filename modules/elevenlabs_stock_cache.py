"""In-process TTL cache for ElevenLabs stock (premade/professional) voices.

Why: GET /api/elevenlabs/voices used to return the entire workspace per
request. After the user-scoping change, cloned voices come from our DB —
but stock voices still need to come from ElevenLabs (we don't catalogue
them). Calling list_voices() per request adds 200-500ms per page load
and burns rate limit quota for data that changes ~never.

This module wraps list_voices() with a 30-minute TTL. On cache miss it
hits ElevenLabs once; concurrent misses share one in-flight request via
asyncio.Lock so a fresh process under load doesn't fan out N requests.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

logger = logging.getLogger(__name__)

# 30 minutes — stock voices are stable; this trades freshness for cost.
TTL_SEC = 30 * 60


class ElevenLabsStockCache:
    def __init__(self, tts_client_factory, ttl_sec: int = TTL_SEC):
        """tts_client_factory: callable returning an ElevenLabsTTS instance.
        Lazy because the caller may not have ELEVENLABS_API_KEY at import time.
        """
        self._factory = tts_client_factory
        self._ttl = ttl_sec
        self._cache: Optional[list[dict]] = None
        self._fetched_at: float = 0.0
        self._lock = asyncio.Lock()

    def _is_fresh(self) -> bool:
        return self._cache is not None and (time.monotonic() - self._fetched_at) < self._ttl

    async def get(self) -> list[dict]:
        """Return cached stock voices (category != 'cloned'). On expiry/miss,
        refetch under a lock so concurrent callers share one upstream call.

        On upstream failure: log and return whatever the cache holds, even
        stale; if the cache is empty, return []. /voices stays usable in
        a degraded mode rather than 500-ing the whole picker.
        """
        if self._is_fresh():
            return self._cache or []

        async with self._lock:
            # Double-check inside the lock — another waiter may have refilled.
            if self._is_fresh():
                return self._cache or []
            try:
                tts = self._factory()
                # ElevenLabs SDK is sync; offload so we don't block the loop.
                all_voices = await asyncio.get_event_loop().run_in_executor(
                    None, tts.list_voices
                )
                stock = [v for v in all_voices if v.get("category") != "cloned"]
                self._cache = stock
                self._fetched_at = time.monotonic()
                return stock
            except Exception as e:
                logger.warning("stock voice fetch failed: %s — serving cached/empty", e)
                return self._cache or []

    def invalidate(self) -> None:
        """Force the next get() to refetch. Used by tests."""
        self._cache = None
        self._fetched_at = 0.0
