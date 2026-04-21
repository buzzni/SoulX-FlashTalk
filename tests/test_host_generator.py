"""Phase 1 — modules/host_generator.py (new)."""
from __future__ import annotations

from unittest.mock import patch

import pytest

pytestmark = pytest.mark.phase1


# ---- Input validation (no Gemini calls required) ----


def test_validate_inputs_text_mode_requires_prompt():
    from modules.host_generator import _validate_inputs

    with pytest.raises(ValueError, match="text_prompt"):
        _validate_inputs("text", None, None, None, None)
    with pytest.raises(ValueError, match="text_prompt"):
        _validate_inputs("text", "x", None, None, None)  # < 5 chars


def test_validate_inputs_face_outfit_requires_both_refs():
    from modules.host_generator import _validate_inputs

    with pytest.raises(ValueError, match="face_ref_path"):
        _validate_inputs("face-outfit", None, None, None, None)
    with pytest.raises(ValueError, match="face_ref_path"):
        _validate_inputs("face-outfit", None, "face.png", None, None)  # missing outfit


def test_validate_inputs_style_ref_requires_style():
    from modules.host_generator import _validate_inputs

    with pytest.raises(ValueError, match="style_ref_path"):
        _validate_inputs("style-ref", None, None, None, None)


def test_validate_inputs_unknown_mode_raises():
    from modules.host_generator import _validate_inputs

    with pytest.raises(ValueError, match="Unknown mode"):
        _validate_inputs("bogus", "x", None, None, None)


# ---- Prompt builder + strength thresholds ----


def test_strength_phrase_thresholds():
    from modules.host_generator import _strength_phrase

    assert "loose inspiration" in _strength_phrase("face", 0.2)
    assert "general style guide" in _strength_phrase("face", 0.5)
    assert "Preserve the key features" in _strength_phrase("face", 0.7)
    assert "Match the reference" in _strength_phrase("face", 0.9)


def test_strength_phrase_boundary_029_vs_030():
    """Threshold boundary: 0.29 → 'loose', 0.30 → 'general'."""
    from modules.host_generator import _strength_phrase

    assert "loose inspiration" in _strength_phrase("face", 0.29)
    assert "general style guide" in _strength_phrase("face", 0.30)


def test_strength_phrase_boundary_085():
    from modules.host_generator import _strength_phrase

    assert "Preserve the key features" in _strength_phrase("face", 0.84)
    assert "Match the reference" in _strength_phrase("face", 0.85)


def test_build_host_prompt_includes_all_parts():
    from modules.host_generator import _build_host_prompt

    prompt = _build_host_prompt(
        mode="text",
        text_prompt="밝은 여성",
        extra_prompt="친근한 미소",
        builder={"성별": "여성", "나이": "30대"},
        face_strength=0.7,
        outfit_strength=0.7,
    )
    assert "밝은 여성" in prompt
    assert "친근한 미소" in prompt
    assert "여성" in prompt and "30대" in prompt


def test_build_system_instruction_includes_negative_prompt():
    from modules.host_generator import _build_host_system_instruction

    sys = _build_host_system_instruction("안경 없음, 검은 머리")
    assert "Avoid" in sys
    assert "안경 없음" in sys


def test_build_system_instruction_no_negative():
    from modules.host_generator import _build_host_system_instruction

    sys = _build_host_system_instruction(None)
    assert "Avoid" not in sys


# ---- Async behavior (mocked Gemini) ----


@pytest.mark.asyncio
async def test_partial_failure_returns_results_when_above_min_success():
    """3 succeed, 1 fail → returns 3 candidates (min_success=2)."""
    from modules import host_generator

    call_count = [0]

    async def fake_one(*args, **kwargs):
        call_count[0] += 1
        # Fail exactly 1 out of 4 (the 3rd call)
        if call_count[0] == 3:
            raise RuntimeError("simulated Gemini quota error")
        return f"/fake/host_s{kwargs['seed']}.png"

    with patch.object(host_generator, "_generate_one", side_effect=fake_one):
        result = await host_generator.generate_host_candidates(
            mode="text",
            text_prompt="여성 쇼호스트",
            n=4,
            min_success=2,
        )

    assert len(result["candidates"]) == 3
    assert result["partial"] is True
    assert len(result["errors"]) == 1


@pytest.mark.asyncio
async def test_all_fail_raises_runtime_error():
    from modules import host_generator

    async def always_fail(*args, **kwargs):
        raise RuntimeError("everything broken")

    with patch.object(host_generator, "_generate_one", side_effect=always_fail):
        with pytest.raises(RuntimeError, match="host candidates succeeded"):
            await host_generator.generate_host_candidates(
                mode="text",
                text_prompt="여성 쇼호스트",
                n=4,
                min_success=2,
            )


@pytest.mark.asyncio
async def test_happy_path_all_four_succeed():
    from modules import host_generator

    async def ok(*args, **kwargs):
        return f"/fake/host_s{kwargs['seed']}.png"

    with patch.object(host_generator, "_generate_one", side_effect=ok):
        result = await host_generator.generate_host_candidates(
            mode="text",
            text_prompt="여성 쇼호스트",
            n=4,
        )
    assert len(result["candidates"]) == 4
    assert result["partial"] is False
    assert result["errors"] is None


@pytest.mark.asyncio
async def test_siblings_not_cancelled_on_single_exception():
    """asyncio.gather(return_exceptions=True) keeps 3 running when 1 raises."""
    from modules import host_generator

    completed = []

    async def slow_then_result(*args, **kwargs):
        # 1st: quick fail; others: would be cancelled if gather cancels on exception
        if kwargs["seed"] == 10:
            raise ValueError("quick fail")
        import asyncio
        await asyncio.sleep(0.01)
        completed.append(kwargs["seed"])
        return f"/fake/{kwargs['seed']}.png"

    with patch.object(host_generator, "_generate_one", side_effect=slow_then_result):
        await host_generator.generate_host_candidates(
            mode="text", text_prompt="testest", n=4, min_success=2,
        )

    # All 3 non-failing tasks must have completed despite sibling exception
    assert sorted(completed) == [42, 77, 128]
