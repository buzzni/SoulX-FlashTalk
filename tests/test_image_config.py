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
    # default person_generation is ALLOW_ADULT
    assert cfg.image_config.person_generation == "ALLOW_ADULT"
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


def test_person_generation_allow_none_for_bg_only(build_config):
    cfg = build_config((1280, 720), person_generation="ALLOW_NONE")
    assert cfg.image_config.person_generation == "ALLOW_NONE"


def test_media_resolution_is_forwarded(build_config):
    cfg = build_config((720, 1280), media_resolution="MEDIA_RESOLUTION_HIGH")
    # SDK normalizes string to enum; accept both shapes
    assert str(cfg.media_resolution).endswith("HIGH") or cfg.media_resolution == "MEDIA_RESOLUTION_HIGH"


def test_system_instruction_passthrough(build_config):
    cfg = build_config((720, 1280), system_instruction="you are a scene generator")
    assert cfg.system_instruction is not None


def test_aspect_ratio_derives_from_target_size(build_config):
    # landscape 16:9
    cfg_l = build_config((1280, 720))
    assert cfg_l.image_config.aspect_ratio == "16:9"
    # square-ish
    cfg_s = build_config((800, 800))
    assert cfg_s.image_config.aspect_ratio == "1:1"
