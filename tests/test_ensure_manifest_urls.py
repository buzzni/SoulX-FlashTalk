"""Unit tests for `_ensure_manifest_urls` — the read-time URL minter.

Plan: docs/plans/result-rehydration-fix-plan.md (Fix 2)

Critical regression coverage:
- host/composition imageUrl is overwritten on every read (TTL re-mint).
- audio_url is overwritten when params has audio_path/audio_key, even if
  a stale audio_url already lives on the row.
- background.url and products[].url likewise overwritten.
- selectedPath is back-filled from `key` for legacy host/composition rows.

Approach: use a fake `media_store.url_for` that returns a sentinel with
an incrementing counter, so we can assert per-call URL freshness without
depending on S3/X-Amz-Date timestamps (which can collide within the same
second under LocalDisk and don't exist at all on the local fs backend).
"""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def app_with_fake_storage(monkeypatch):
    """Import app.py and swap the media_store with a counter-backed fake.

    The fake mints `https://stub/<key>?v=<n>` URLs so tests can assert that
    consecutive _ensure_manifest_urls calls produce different URLs (the
    canonical TTL re-mint guarantee).
    """
    import app as app_module

    counter = {"n": 0}

    class _FakeStore:
        def url_for(self, key, *, expires_in=None, download_filename=None):
            counter["n"] += 1
            return f"https://stub/{key}?v={counter['n']}"

    fake = _FakeStore()
    # _media_url() reads `from modules import storage as _storage` and
    # then calls `_storage.media_store.url_for(...)`. Patch the attribute,
    # not a re-imported name (the safe pattern documented in
    # tests/conftest.py:s3_media_store_swap).
    monkeypatch.setattr("modules.storage.media_store", fake)
    return app_module, counter


# ── host / composition ─────────────────────────────────────────────


def test_host_imageUrl_overwritten_when_stale(app_with_fake_storage):
    """REGRESSION: meta.host.imageUrl from dispatch time has a 1h TTL.
    Read-time enrichment must mint a fresh URL on every call."""
    app_module, _ = app_with_fake_storage
    doc = {
        "meta": {
            "host": {
                "selectedPath": "outputs/hosts/saved/host_abc.png",
                "imageUrl": "https://EXPIRED.s3.amazonaws.com/host_abc.png?stale=1",
                "url": "https://EXPIRED.s3.amazonaws.com/host_abc.png?stale=1",
            },
        },
    }
    out1 = app_module._ensure_manifest_urls(doc)
    first_url = out1["meta"]["host"]["imageUrl"]
    assert first_url.startswith("https://stub/outputs/hosts/saved/host_abc.png?v=")
    assert out1["meta"]["host"]["url"] == first_url

    # In-place mutation means out2 is the same dict as out1 — capture
    # first_url above before the second call rewrites it.
    out2 = app_module._ensure_manifest_urls(out1)
    assert out2["meta"]["host"]["imageUrl"] != first_url


def test_composition_selectedUrl_overwritten_when_stale(app_with_fake_storage):
    """REGRESSION: meta.composition.selectedUrl is the same TTL trap as host."""
    app_module, _ = app_with_fake_storage
    doc = {
        "meta": {
            "composition": {
                "selectedPath": "outputs/composites/comp_xyz.png",
                "selectedUrl": "https://EXPIRED.s3.amazonaws.com/comp_xyz.png",
            },
        },
    }
    out = app_module._ensure_manifest_urls(doc)
    fresh = out["meta"]["composition"]["selectedUrl"]
    assert fresh.startswith("https://stub/outputs/composites/comp_xyz.png?v=")
    assert out["meta"]["composition"]["url"] == fresh


def test_host_selectedPath_backfilled_from_key(app_with_fake_storage):
    """Legacy rows may have only `key` (PR-4 cleanup phase). The frontend
    rehydrate path reads `selectedPath`; ensure it's populated."""
    app_module, _ = app_with_fake_storage
    doc = {
        "meta": {
            "host": {
                "key": "outputs/hosts/saved/host_legacy.png",
            },
        },
    }
    out = app_module._ensure_manifest_urls(doc)
    assert out["meta"]["host"]["selectedPath"] == "outputs/hosts/saved/host_legacy.png"
    assert out["meta"]["host"]["imageUrl"].startswith("https://stub/")


def test_composition_selectedPath_backfilled_from_key(app_with_fake_storage):
    app_module, _ = app_with_fake_storage
    doc = {
        "meta": {
            "composition": {
                "key": "outputs/composites/comp_legacy.png",
            },
        },
    }
    out = app_module._ensure_manifest_urls(doc)
    assert out["meta"]["composition"]["selectedPath"] == "outputs/composites/comp_legacy.png"
    assert out["meta"]["composition"]["selectedUrl"].startswith("https://stub/")


def test_host_unchanged_when_no_key_or_path(app_with_fake_storage):
    """Defensive: a row with no usable reference should not gain stub URLs."""
    app_module, _ = app_with_fake_storage
    doc = {"meta": {"host": {"prompt": "hello", "mode": "text"}}}
    out = app_module._ensure_manifest_urls(doc)
    assert "imageUrl" not in out["meta"]["host"]
    assert "url" not in out["meta"]["host"]


# ── audio ────────────────────────────────────────────────────────


def test_audio_url_overwritten_when_stale(app_with_fake_storage):
    """REGRESSION: codex finding #2. The pre-fix logic only minted
    audio_url when absent, leaving stale URLs in place."""
    app_module, _ = app_with_fake_storage
    doc = {
        "params": {
            "audio_path": "outputs/tts_def.wav",
            "audio_url": "https://EXPIRED.s3.amazonaws.com/tts_def.wav",
        },
    }
    out = app_module._ensure_manifest_urls(doc)
    assert out["params"]["audio_url"].startswith("https://stub/outputs/tts_def.wav?v=")
    assert out["params"]["audio_url"] != "https://EXPIRED.s3.amazonaws.com/tts_def.wav"


def test_audio_url_minted_from_audio_key_first(app_with_fake_storage):
    """audio_key wins over audio_path when both exist (canonical wins)."""
    app_module, _ = app_with_fake_storage
    doc = {
        "params": {
            "audio_key": "outputs/canonical.wav",
            "audio_path": "outputs/legacy.wav",
        },
    }
    out = app_module._ensure_manifest_urls(doc)
    assert "outputs/canonical.wav" in out["params"]["audio_url"]


def test_audio_skipped_when_path_is_temp_garbage(app_with_fake_storage):
    """If params.audio_path is a /opt/.../temp/... absolute path (the bug
    we're fixing in Fix 1), no normalization is possible — audio_url must
    not be set to a bogus URL."""
    app_module, _ = app_with_fake_storage
    doc = {
        "params": {
            "audio_path": "/opt/home/jack/workspace/SoulX-FlashTalk/temp/job-input-x.wav",
        },
    }
    out = app_module._ensure_manifest_urls(doc)
    assert "audio_url" not in out["params"]


# ── background / products ──────────────────────────────────────────


def test_background_url_overwritten_when_stale(app_with_fake_storage):
    app_module, _ = app_with_fake_storage
    doc = {
        "meta": {
            "background": {
                "source": "upload",
                "key": "uploads/bg_xyz.png",
                "url": "https://EXPIRED.s3.amazonaws.com/bg_xyz.png",
            },
        },
    }
    out = app_module._ensure_manifest_urls(doc)
    assert out["meta"]["background"]["url"].startswith("https://stub/uploads/bg_xyz.png?v=")


def test_background_skipped_when_source_is_preset(app_with_fake_storage):
    """preset/prompt/url backgrounds are not stored under our buckets;
    enrichment must leave them alone."""
    app_module, _ = app_with_fake_storage
    doc = {
        "meta": {"background": {"source": "preset", "presetId": "studio_white"}},
    }
    out = app_module._ensure_manifest_urls(doc)
    assert "url" not in out["meta"]["background"]


def test_products_url_overwritten_when_stale(app_with_fake_storage):
    app_module, _ = app_with_fake_storage
    doc = {
        "meta": {
            "products": [
                {
                    "name": "p1",
                    "key": "uploads/p1.png",
                    "url": "https://EXPIRED.s3.amazonaws.com/p1.png",
                },
                {"name": "p2", "key": "uploads/p2.png"},
            ],
        },
    }
    out = app_module._ensure_manifest_urls(doc)
    assert out["meta"]["products"][0]["url"].startswith("https://stub/uploads/p1.png?v=")
    assert out["meta"]["products"][1]["url"].startswith("https://stub/uploads/p2.png?v=")


# ── idempotency + structural ────────────────────────────────────────


def test_idempotent_two_calls_yield_same_shape(app_with_fake_storage):
    """Calling enrichment twice produces the same dict shape (URLs differ
    by counter — that's the point — but no extra keys appear)."""
    app_module, _ = app_with_fake_storage
    doc = {
        "meta": {
            "host": {"selectedPath": "outputs/hosts/saved/host_abc.png"},
            "composition": {"selectedPath": "outputs/composites/comp_xyz.png"},
            "products": [{"name": "p", "key": "uploads/p.png"}],
            "background": {"source": "upload", "key": "uploads/bg.png"},
        },
        "params": {"audio_path": "outputs/tts_def.wav"},
    }
    out1 = app_module._ensure_manifest_urls(doc)
    keys1 = {
        "host": sorted(out1["meta"]["host"].keys()),
        "composition": sorted(out1["meta"]["composition"].keys()),
        "products": sorted(out1["meta"]["products"][0].keys()),
        "background": sorted(out1["meta"]["background"].keys()),
        "params": sorted(out1["params"].keys()),
    }
    out2 = app_module._ensure_manifest_urls(out1)
    keys2 = {
        "host": sorted(out2["meta"]["host"].keys()),
        "composition": sorted(out2["meta"]["composition"].keys()),
        "products": sorted(out2["meta"]["products"][0].keys()),
        "background": sorted(out2["meta"]["background"].keys()),
        "params": sorted(out2["params"].keys()),
    }
    assert keys1 == keys2


def test_storage_key_prefix_variants(app_with_fake_storage):
    """Smoke-test all three bucket prefixes pass through unchanged."""
    app_module, _ = app_with_fake_storage
    for key in [
        "outputs/composites/comp.png",
        "outputs/hosts/saved/host.png",
        "uploads/asset.png",
        "examples/sample.png",
    ]:
        doc = {"meta": {"host": {"selectedPath": key}}}
        out = app_module._ensure_manifest_urls(doc)
        assert key in out["meta"]["host"]["imageUrl"]
