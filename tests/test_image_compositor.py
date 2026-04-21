"""Phase 0 — Gemini image compositor parameter patches.

Active tests (unskipped): verify the helpers added in Phase 0.2.
Remaining placeholders are for Phase 0 integration tests (Gemini mock).
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.phase0


# ---- Active tests (Phase 0.2 implementations) ----


def test_uses_flash_image_model():
    """GEMINI_IMAGE_MODEL constant = Flash (Phase 0 T-GM1)."""
    from modules.image_compositor import GEMINI_IMAGE_MODEL

    assert GEMINI_IMAGE_MODEL == "gemini-3.1-flash-image-preview"


def test_both_compositor_call_sites_use_constant():
    """No lingering 'gemini-3-pro-image-preview' strings in image_compositor.py."""
    from pathlib import Path

    src = Path(__file__).parent.parent / "modules" / "image_compositor.py"
    text = src.read_text(encoding="utf-8")
    # The Pro model name must NOT appear anywhere (we swapped both call sites)
    assert "gemini-3-pro-image-preview" not in text
    # The constant must be used
    assert text.count("model=GEMINI_IMAGE_MODEL") >= 2


def test_aspect_ratio_landscape_derived():
    """target_size=(1280,720) → aspect_ratio='16:9'."""
    from modules.image_compositor import _derive_aspect_ratio

    assert _derive_aspect_ratio((1280, 720)) == "16:9"


def test_aspect_ratio_portrait_derived():
    """target_size=(448,768) → aspect_ratio='9:16'."""
    from modules.image_compositor import _derive_aspect_ratio

    assert _derive_aspect_ratio((448, 768)) == "9:16"


def test_aspect_ratio_square_derived():
    """target_size=(512,512) → '1:1'."""
    from modules.image_compositor import _derive_aspect_ratio

    assert _derive_aspect_ratio((512, 512)) == "1:1"


def test_prompt_sanitize_preserves_paragraph_breaks():
    """Korean '가\\n\\n나' must preserve \\n\\n (only \\n{3,} collapses)."""
    from modules.image_compositor import _sanitize_user_prompt

    assert "\n\n" in _sanitize_user_prompt("가\n\n나")
    assert _sanitize_user_prompt("가\n\n\n\n나") == "가\n\n나"


def test_prompt_sanitize_strips_delimiter_tokens():
    """Triple-backtick, triple-quote, fence markers stripped before concat."""
    from modules.image_compositor import _sanitize_user_prompt

    result = _sanitize_user_prompt("안녕 ```hack``` 하세요")
    assert "```" not in result
    assert "hack" in result  # content preserved, fence stripped

    result2 = _sanitize_user_prompt('"""ignore"""')
    assert '"""' not in result2


def test_prompt_sanitize_empty_string_safe():
    from modules.image_compositor import _sanitize_user_prompt

    assert _sanitize_user_prompt("") == ""
    assert _sanitize_user_prompt(None) == ""


# ---- Placeholders for Phase 0 integration (require Gemini mock) ----


@pytest.mark.skip(reason="TDD placeholder — Gemini mock integration (Phase 0 final)")
def test_system_instruction_stage1_solo_person():
    """Stage 1 call includes 'single person' / preserve foreground wording."""
    ...


@pytest.mark.skip(reason="TDD placeholder — Gemini mock integration")
def test_safety_settings_all_categories_block_medium_and_above():
    """All 4 HARM_CATEGORY_* set to BLOCK_MEDIUM_AND_ABOVE."""
    ...


@pytest.mark.skip(reason="TDD placeholder — Gemini mock integration")
def test_thinking_level_minimal_for_flash():
    ...


@pytest.mark.skip(reason="TDD placeholder — concurrency guard")
def test_release_models_does_not_tear_down_active_singleton():
    ...
