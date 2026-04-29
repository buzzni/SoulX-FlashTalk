"""Tests for ElevenLabsStockCache: TTL, lock, degraded fallback."""
from __future__ import annotations

import asyncio
import pytest

from modules.elevenlabs_stock_cache import ElevenLabsStockCache


class _StubTTS:
    def __init__(self, voices, raise_exc: Exception | None = None):
        self.voices = voices
        self.raise_exc = raise_exc
        self.call_count = 0

    def list_voices(self):
        self.call_count += 1
        if self.raise_exc:
            raise self.raise_exc
        return list(self.voices)


async def test_first_get_fetches_and_filters_cloned():
    stub = _StubTTS([
        {"voice_id": "s1", "name": "stock1", "category": "premade"},
        {"voice_id": "c1", "name": "clone1", "category": "cloned"},
        {"voice_id": "s2", "name": "stock2", "category": "professional"},
    ])
    cache = ElevenLabsStockCache(lambda: stub, ttl_sec=60)
    out = await cache.get()
    assert [v["voice_id"] for v in out] == ["s1", "s2"]
    assert stub.call_count == 1


async def test_within_ttl_no_refetch():
    stub = _StubTTS([{"voice_id": "s1", "name": "x", "category": "premade"}])
    cache = ElevenLabsStockCache(lambda: stub, ttl_sec=60)
    await cache.get()
    await cache.get()
    await cache.get()
    assert stub.call_count == 1


async def test_invalidate_forces_refetch():
    stub = _StubTTS([{"voice_id": "s1", "name": "x", "category": "premade"}])
    cache = ElevenLabsStockCache(lambda: stub, ttl_sec=60)
    await cache.get()
    cache.invalidate()
    await cache.get()
    assert stub.call_count == 2


async def test_concurrent_misses_share_one_call():
    """Without the lock, N concurrent first-callers all fan out to ElevenLabs.
    The lock should funnel them through one upstream call."""
    import time

    call_count = 0

    class _SlowStub:
        def list_voices(self_inner):
            nonlocal call_count
            call_count += 1
            time.sleep(0.05)  # simulate network — lets concurrent waiters queue
            return [{"voice_id": "s1", "name": "x", "category": "premade"}]

    stub = _SlowStub()
    cache = ElevenLabsStockCache(lambda: stub, ttl_sec=60)
    results = await asyncio.gather(*(cache.get() for _ in range(5)))

    assert call_count == 1
    for r in results:
        assert [v["voice_id"] for v in r] == ["s1"]


async def test_upstream_failure_serves_empty_when_cold():
    stub = _StubTTS([], raise_exc=RuntimeError("boom"))
    cache = ElevenLabsStockCache(lambda: stub, ttl_sec=60)
    out = await cache.get()
    assert out == []


async def test_upstream_failure_serves_stale_when_warm():
    """If we have data and the next refresh fails, keep serving the old set
    rather than 500-ing the picker."""
    initial = [{"voice_id": "s1", "name": "x", "category": "premade"}]
    stub = _StubTTS(initial)
    cache = ElevenLabsStockCache(lambda: stub, ttl_sec=0)  # always expired
    await cache.get()  # populate
    stub.raise_exc = RuntimeError("network down")
    out = await cache.get()
    assert [v["voice_id"] for v in out] == ["s1"]
