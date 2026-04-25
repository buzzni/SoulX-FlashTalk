"""Phase 1 — modules/host_generator.py (new)."""
from __future__ import annotations

from unittest.mock import patch

import pytest

pytestmark = pytest.mark.phase1


# ---- Input validation (no Gemini calls required) ----


def test_sanitize_refs_drops_paths_in_text_mode():
    """Defense-in-depth: when frontend leaves stale face/outfit ref paths in
    the form payload after a mode switch to "설명으로 만들기", the backend
    must drop them so Gemini doesn't silently attach the prior session's
    images. See modules/host_generator.py::_sanitize_refs_by_mode docstring.
    """
    from modules.host_generator import _sanitize_refs_by_mode

    face, outfit, style = _sanitize_refs_by_mode(
        "text", "/uploads/face.png", "/uploads/outfit.png", "/uploads/style.png"
    )
    assert face is None and outfit is None and style is None


def test_sanitize_refs_passthrough_in_image_modes():
    from modules.host_generator import _sanitize_refs_by_mode

    for mode in ("face-outfit", "style-ref"):
        face, outfit, style = _sanitize_refs_by_mode(
            mode, "/uploads/face.png", "/uploads/outfit.png", "/uploads/style.png"
        )
        assert face == "/uploads/face.png"
        assert outfit == "/uploads/outfit.png"
        assert style == "/uploads/style.png"


def test_validate_inputs_text_mode_requires_prompt():
    from modules.host_generator import _validate_inputs

    with pytest.raises(ValueError, match="text_prompt"):
        _validate_inputs("text", None, None, None, None)
    with pytest.raises(ValueError, match="text_prompt"):
        _validate_inputs("text", "x", None, None, None)  # < 5 chars


def test_validate_inputs_image_modes_need_at_least_one_input():
    """Relaxed contract (2026-04-23): image modes accept any combination of
    face/outfit/style ref or an outfit_text description — previously
    'face-outfit' hard-required BOTH images and 'style-ref' hard-required
    style_ref_path, which broke the common "face photo + outfit description"
    flow with an unrelated-sounding error."""
    from modules.host_generator import _validate_inputs

    # Empty state → rejected
    with pytest.raises(ValueError, match="at least one"):
        _validate_inputs("face-outfit", None, None, None, None)
    with pytest.raises(ValueError, match="at least one"):
        _validate_inputs("style-ref", None, None, None, None)

    # Face ref alone is enough
    _validate_inputs("face-outfit", None, "face.png", None, None)
    _validate_inputs("style-ref", None, "face.png", None, None)

    # Face ref + outfit text (the regression case) should pass
    _validate_inputs("style-ref", None, "face.png", None, None, "베이지 니트")

    # outfit_text alone (rare but technically valid) should also pass
    _validate_inputs("face-outfit", None, None, None, None, "청바지 셔츠")


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

    # Strength clauses moved out of _build_host_prompt — they now ride
    # next to each labeled image in _sync_generate's interleaved contents.
    prompt = _build_host_prompt(
        mode="text",
        text_prompt="밝은 여성",
        extra_prompt="친근한 미소",
        builder={"성별": "여성", "나이": "30대"},
    )
    assert "밝은 여성" in prompt
    assert "친근한 미소" in prompt
    assert "여성" in prompt and "30대" in prompt


def test_build_host_prompt_includes_outfit_text():
    """outfit_text is forwarded into the body so Gemini sees the cue twice
    (here + as a labeled segment in the interleaved contents)."""
    from modules.host_generator import _build_host_prompt

    prompt = _build_host_prompt(
        mode="face-outfit",
        text_prompt="30대 여성",
        extra_prompt=None,
        builder=None,
        outfit_text="베이지 니트, 청바지",
    )
    assert "베이지 니트" in prompt
    # The prompt template labels the outfit segment "Outfit description:"
    # (English). The assertion previously looked for the Korean label
    # "의상 설명" and silently rotted when the template was switched.
    # Match the current template so the test tracks reality.
    assert "Outfit description" in prompt


def test_build_system_instruction_includes_negative_prompt():
    from modules.host_generator import _build_host_system_instruction

    sys = _build_host_system_instruction("안경 없음, 검은 머리")
    assert "Avoid" in sys
    assert "안경 없음" in sys


def test_build_system_instruction_no_negative():
    from modules.host_generator import _build_host_system_instruction

    sys = _build_host_system_instruction(None)
    assert "Avoid" not in sys


# ---- Multi-image labeling (regression for "outfit ref ignored" bug, 2026-04-23) ----


def test_sync_generate_interleaves_face_and_outfit_with_explicit_labels(tmp_path, monkeypatch):
    """Capture the actual `contents` list sent to client.models.generate_content
    and verify each image is preceded by an explicit FACE / OUTFIT label.

    Before the fix the contents list was just [prompt_text, face_img, outfit_img]
    with the prompt body referring to "the reference face" / "the reference
    outfit" abstractly — Gemini had no way to map either phrase to either
    image, so the outfit photo got ignored across all 4 candidates.
    """
    from PIL import Image as _PIL
    from modules import host_generator

    # Real on-disk image files so _sync_generate's `os.path.exists` + `Image.open`
    # don't have to be mocked.
    face_path = tmp_path / "face.png"
    outfit_path = tmp_path / "outfit.png"
    _PIL.new("RGB", (10, 10), (255, 0, 0)).save(face_path)
    _PIL.new("RGB", (10, 10), (0, 255, 0)).save(outfit_path)

    captured = {}

    class _FakeImagePart:
        inline_data = type("D", (), {"data": _png_bytes((10, 10), (50, 50, 50))})()
    class _FakeContent:
        parts = [_FakeImagePart()]
    class _FakeCandidate:
        content = _FakeContent()
    class _FakeResp:
        candidates = [_FakeCandidate()]

    class _FakeModels:
        def generate_content(self, model, contents, config):
            captured["contents"] = contents
            captured["model"] = model
            return _FakeResp()

    class _FakeClient:
        models = _FakeModels()

    monkeypatch.setattr("modules.image_compositor._get_gemini_client", lambda: _FakeClient())

    out_dir = tmp_path / "out"
    out_dir.mkdir()

    host_generator._sync_generate(
        seed=10,
        mode="face-outfit",
        text_prompt="30대 여성",
        face_ref_path=str(face_path),
        outfit_ref_path=str(outfit_path),
        style_ref_path=None,
        extra_prompt=None,
        builder=None,
        negative_prompt=None,
        face_strength=0.95,   # "똑같이"
        outfit_strength=0.7,  # "가깝게"
        output_dir=str(out_dir),
    )

    contents = captured["contents"]
    # Must contain explicit per-image labels — otherwise we've regressed
    # to the original ambiguous "all images mashed together" layout.
    label_blob = " ".join(c for c in contents if isinstance(c, str))
    assert "FACE" in label_blob
    assert "OUTFIT" in label_blob or "CLOTHING" in label_blob
    # Strength clauses must travel with their respective images
    assert "Match the reference face as exactly as possible" in label_blob
    assert "Preserve the key features of the reference outfit closely" in label_blob


def test_sync_generate_includes_outfit_text_when_no_outfit_image(tmp_path, monkeypatch):
    """outfit_text alone (no outfit image) still reaches the prompt — needed
    so users without an outfit photo can describe it in writing."""
    from PIL import Image as _PIL
    from modules import host_generator

    face_path = tmp_path / "face.png"
    _PIL.new("RGB", (10, 10), (255, 0, 0)).save(face_path)

    captured = {}

    class _FakeImagePart:
        inline_data = type("D", (), {"data": _png_bytes((10, 10), (0, 0, 0))})()
    class _FakeResp:
        candidates = [type("C", (), {"content": type("X", (), {"parts": [_FakeImagePart()]})()})()]

    class _FakeClient:
        class models:
            @staticmethod
            def generate_content(model, contents, config):
                captured["contents"] = contents
                return _FakeResp()

    monkeypatch.setattr("modules.image_compositor._get_gemini_client", lambda: _FakeClient())

    out_dir = tmp_path / "out"
    out_dir.mkdir()

    host_generator._sync_generate(
        seed=10,
        mode="style-ref",
        text_prompt="30대 여성",
        face_ref_path=str(face_path),
        outfit_ref_path=None,
        style_ref_path=None,
        extra_prompt=None,
        builder=None,
        negative_prompt=None,
        face_strength=0.7,
        outfit_strength=0.7,
        output_dir=str(out_dir),
        outfit_text="베이지 니트, 청바지",
    )

    label_blob = " ".join(c for c in captured["contents"] if isinstance(c, str))
    assert "베이지 니트" in label_blob
    # Should NOT claim there's an outfit image
    assert "Reference image — OUTFIT" not in label_blob


# ---- System instruction + stream init ----


def test_system_instruction_pins_beige_background():
    """Step 1 must always produce a plain beige backdrop — Step 2 composites
    onto scene backgrounds so anything else (props, outdoor, textured)
    breaks rembg extraction downstream."""
    from modules.host_generator import _build_host_system_instruction
    sys = _build_host_system_instruction(None)
    assert "beige" in sys.lower() or "cream" in sys.lower()
    assert "no props" in sys.lower() or "no furniture" in sys.lower()


@pytest.mark.asyncio
async def test_stream_host_emits_init_before_candidates(monkeypatch):
    """Frontend relies on the init event to know the backend accepted the
    request — placeholder spinners only render after init arrives. Regression
    for: "호출 성공시에만 하단 후보 4개의 스피너가 돌도록해줘" (2026-04-23)."""
    from modules import host_generator

    async def fake_one(*a, **kw):
        return f"/fake/host_s{kw['seed']}.png"

    monkeypatch.setattr(host_generator, "_generate_one", fake_one)

    events = []
    async for evt in host_generator.stream_host_candidates(
        mode="text",
        text_prompt="30대 여성 쇼호스트",
        n=4,
    ):
        events.append(evt)

    assert events[0]["type"] == "init"
    assert events[0]["total"] == 4
    assert events[0]["seeds"] == [10, 42, 77, 128]  # fixed defaults (no retry)
    # And candidates follow (4 of them)
    assert sum(1 for e in events if e["type"] == "candidate") == 4


# ---- Seed policy (regression for "다시 만들기 = same 4 results" complaint) ----


def test_resolve_seeds_falls_back_to_fixed_defaults():
    """No caller seeds → deterministic FIXED_DEFAULT_SEEDS for the first run."""
    from modules.host_generator import _resolve_seeds, FIXED_DEFAULT_SEEDS
    assert _resolve_seeds(None, 4) == FIXED_DEFAULT_SEEDS[:4]
    assert _resolve_seeds([], 4) == FIXED_DEFAULT_SEEDS[:4]


def test_resolve_seeds_uses_caller_supplied_when_provided():
    """Frontend passes random seeds on retry — they win over the defaults."""
    from modules.host_generator import _resolve_seeds
    assert _resolve_seeds([111, 222, 333, 444], 4) == [111, 222, 333, 444]


def test_resolve_seeds_pads_short_caller_lists():
    """If frontend somehow sends fewer seeds than n, pad with defaults so
    we still hit the requested candidate count."""
    from modules.host_generator import _resolve_seeds, FIXED_DEFAULT_SEEDS
    out = _resolve_seeds([999], 4)
    assert out[0] == 999
    assert out[1:] == FIXED_DEFAULT_SEEDS[1:4]


def _png_bytes(size, color):
    """Tiny PNG byte payload for fake Gemini responses."""
    from io import BytesIO
    from PIL import Image as _PIL
    buf = BytesIO()
    _PIL.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


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
