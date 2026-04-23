"""Unit tests for _build_gemini_image_config parameter plumbing.

We don't hit the Gemini API here — just assert the types/values we pass to
google.genai.types.GenerateContentConfig so refactors can't silently drop a
parameter (e.g., forget to forward `seed`).
"""
from __future__ import annotations

import pytest


@pytest.fixture
def build_config():
    from modules.image_compositor import _build_gemini_image_config
    return _build_gemini_image_config


def test_defaults_include_safety_and_aspect_ratio(build_config):
    cfg = build_config((720, 1280))
    # portrait 9:16 derived from target_size
    assert cfg.image_config.aspect_ratio == "9:16"
    assert cfg.image_config.image_size == "1K"
    # person_generation is intentionally absent — Gemini API rejects it (Vertex-only)
    assert cfg.image_config.person_generation is None
    # safety settings set on 4 categories
    assert len(cfg.safety_settings) == 4
    # response_modalities forces image return
    assert "Image" in cfg.response_modalities
    # thinking_level=minimal for Flash
    assert cfg.thinking_config is not None
    # optional params default unset
    assert cfg.seed is None
    assert cfg.media_resolution is None
    assert cfg.temperature is None


def test_seed_is_forwarded_as_int(build_config):
    cfg = build_config((720, 1280), seed=42)
    assert cfg.seed == 42


def test_temperature_is_forwarded_as_float(build_config):
    cfg = build_config((720, 1280), temperature=0.7)
    assert cfg.temperature == pytest.approx(0.7)


def test_media_resolution_is_forwarded(build_config):
    cfg = build_config((720, 1280), media_resolution="MEDIA_RESOLUTION_HIGH")
    # SDK normalizes string to enum; accept both shapes
    assert str(cfg.media_resolution).endswith("HIGH") or cfg.media_resolution == "MEDIA_RESOLUTION_HIGH"


def test_system_instruction_passthrough(build_config):
    cfg = build_config((720, 1280), system_instruction="you are a scene generator")
    assert cfg.system_instruction is not None


def test_config_serializes_for_mldev_backend(build_config):
    """Regression: the Gemini API (mldev) backend rejects person_generation,
    prominent_people, etc. Make sure the config we build can actually round-
    trip through the SDK's _GenerateContentConfig_to_mldev serializer without
    raising — otherwise every generate call dies before leaving the process.
    """
    from google.genai.models import _GenerateContentConfig_to_mldev

    cfg = build_config(
        (720, 1280),
        system_instruction="test",
        seed=42,
        media_resolution="MEDIA_RESOLUTION_MEDIUM",
        temperature=0.7,
    )
    # Should NOT raise — if it does, the live API call would also fail.
    _GenerateContentConfig_to_mldev(api_client=None, from_object=cfg, parent_object={})


def test_aspect_ratio_derives_from_target_size(build_config):
    # landscape 16:9
    cfg_l = build_config((1280, 720))
    assert cfg_l.image_config.aspect_ratio == "16:9"
    # square-ish
    cfg_s = build_config((800, 800))
    assert cfg_s.image_config.aspect_ratio == "1:1"


# ========================================
# Gemini TEXT model (translate_direction_ko_to_en) config plumbing
# ========================================


class _FakeClient:
    """Captures the config kwargs generate_content receives."""
    def __init__(self):
        self.captured = None

    @property
    def models(self):
        return self  # unified namespace — test uses client.models.generate_content

    def generate_content(self, model, contents, config=None):
        self.captured = {"model": model, "contents": contents, "config": config}
        class _Resp:
            text = "translated english text"
        return _Resp()


def test_translate_ko_to_en_uses_thinking_minimal_and_token_cap(monkeypatch):
    """Gemini translation call is configured for short, cheap, deterministic output."""
    # Reset the lru_cache so this test sees a fresh call
    from modules import composite_generator
    composite_generator.translate_direction_ko_to_en.cache_clear()

    fake = _FakeClient()
    monkeypatch.setattr(
        "modules.image_compositor._get_gemini_client",
        lambda: fake,
    )

    result = composite_generator.translate_direction_ko_to_en("밝은 분위기의 스튜디오")
    assert result == "translated english text"

    cfg = fake.captured["config"]
    assert cfg is not None, "translation call must pass a GenerateContentConfig"
    assert cfg.max_output_tokens == 256
    assert cfg.thinking_config is not None
    assert cfg.system_instruction is not None
    assert fake.captured["model"] == "gemini-2.5-flash"


def test_translate_ko_to_en_empty_input_returns_empty_without_client_call(monkeypatch):
    """Empty / whitespace-only direction shouldn't round-trip to Gemini."""
    from modules import composite_generator
    composite_generator.translate_direction_ko_to_en.cache_clear()

    called = {"hit": False}

    def _unexpected():
        called["hit"] = True
        raise AssertionError("client should not be called for empty input")

    monkeypatch.setattr("modules.image_compositor._get_gemini_client", _unexpected)

    assert composite_generator.translate_direction_ko_to_en("") == ""
    assert composite_generator.translate_direction_ko_to_en("   ") == ""
    assert called["hit"] is False
