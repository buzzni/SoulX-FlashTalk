"""Phase 0 — ElevenLabs v3 upgrade + parameter patches."""
from __future__ import annotations

import inspect

import pytest

pytestmark = pytest.mark.phase0


# ---- Active tests (Phase 0.3 implementations) ----


def test_config_model_id_is_v3():
    """config.ELEVENLABS_OPTIONS.model_id == 'eleven_v3'."""
    import config

    assert config.ELEVENLABS_OPTIONS["model_id"] == "eleven_v3"


def test_config_includes_new_params():
    """Phase 0 T-EL1/2/3 defaults present."""
    import config

    opts = config.ELEVENLABS_OPTIONS
    assert opts["use_speaker_boost"] is True  # T-EL1
    assert opts["language_code"] == "ko"  # T-EL2
    assert opts["speed"] == 1.0  # T-EL3


def test_tts_class_default_model_is_v3():
    """ElevenLabsTTS(...) defaults to v3 model."""
    from modules.elevenlabs_tts import ElevenLabsTTS

    sig = inspect.signature(ElevenLabsTTS.__init__)
    assert sig.parameters["model_id"].default == "eleven_v3"


def test_generate_speech_accepts_new_params():
    """generate_speech has speed, use_speaker_boost, language_code."""
    from modules.elevenlabs_tts import ElevenLabsTTS

    sig = inspect.signature(ElevenLabsTTS.generate_speech)
    params = set(sig.parameters.keys())
    assert "speed" in params
    assert "use_speaker_boost" in params
    assert "language_code" in params


def test_generate_speech_raises_on_text_over_5000_chars():
    """v3 5000-char limit enforced before API call (Phase 0 T-EL4)."""
    from modules.elevenlabs_tts import ElevenLabsTTS

    tts = ElevenLabsTTS(api_key="test", model_id="eleven_v3")
    # Build 5001-char string with a [breath] token included
    oversized = ("x" * 4990) + " [breath] end"
    assert len(oversized) > 5000
    with pytest.raises(ValueError, match="5000"):
        tts.generate_speech(
            text=oversized,
            voice_id="v1",
            output_path="/tmp/out.wav",
        )


def test_config_max_chars_matches_v3_limit():
    import config

    assert config.ELEVENLABS_MAX_CHARS == 5000


# ---- Placeholders (need httpx mock to verify payload shape) ----


@pytest.mark.skip(reason="TDD placeholder — httpx mock to inspect payload")
def test_payload_includes_use_speaker_boost():
    ...


@pytest.mark.skip(reason="TDD placeholder — httpx mock")
def test_payload_includes_language_code_ko():
    ...


@pytest.mark.skip(reason="TDD placeholder — httpx mock")
def test_payload_includes_speed():
    ...


@pytest.mark.skip(reason="TDD placeholder — breath tokens forwarded verbatim")
def test_breath_tokens_passed_through_to_v3():
    ...
