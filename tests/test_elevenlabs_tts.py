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


def _capture_generate_payload(monkeypatch, **kwargs):
    """Invoke ElevenLabsTTS.generate_speech while intercepting the outgoing
    httpx POST — returns the JSON payload the real API would have received.
    Skips the subsequent ffmpeg conversion by stubbing subprocess.run.
    """
    import httpx
    from modules.elevenlabs_tts import ElevenLabsTTS

    captured = {}

    class _Resp:
        status_code = 200
        content = b"fake-mp3-bytes"
        def raise_for_status(self):
            return None

    class _FakeClient:
        def __init__(self, *a, **kw):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *exc):
            return False
        def post(self, url, headers=None, json=None, **kw):
            captured["url"] = url
            captured["json"] = json
            return _Resp()

    monkeypatch.setattr(httpx, "Client", _FakeClient)

    # Stub ffmpeg
    import subprocess
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: None)

    # Stub file writes so we don't create /tmp artifacts
    import builtins
    real_open = builtins.open

    class _NullFile:
        def __enter__(self):
            return self
        def __exit__(self, *exc):
            return False
        def write(self, *a, **kw):
            return None

    def _open(path, mode="r", *a, **kw):
        if "w" in mode or "a" in mode:
            return _NullFile()
        return real_open(path, mode, *a, **kw)

    monkeypatch.setattr(builtins, "open", _open)

    # os.path.exists+remove both called on the mp3 path; let real calls run
    tts = ElevenLabsTTS(api_key="test", model_id="eleven_v3")
    tts.generate_speech(
        text=kwargs.get("text", "안녕"),
        voice_id=kwargs.get("voice_id", "v1"),
        output_path=kwargs.get("output_path", "/tmp/out.wav"),
        stability=kwargs.get("stability", 0.5),
        similarity_boost=kwargs.get("similarity_boost", 0.75),
        style=kwargs.get("style", 0.0),
        speed=kwargs.get("speed", 1.0),
        use_speaker_boost=kwargs.get("use_speaker_boost", True),
        language_code=kwargs.get("language_code", "ko"),
    )
    return captured


def test_payload_includes_apply_text_normalization_on(monkeypatch):
    """v3 numeric/abbrev normalization — important for Korean commerce scripts."""
    captured = _capture_generate_payload(monkeypatch)
    assert captured["json"]["apply_text_normalization"] == "on"


def test_payload_includes_use_speaker_boost(monkeypatch):
    captured = _capture_generate_payload(monkeypatch)
    assert captured["json"]["voice_settings"]["use_speaker_boost"] is True


def test_payload_includes_language_code_ko_default(monkeypatch):
    captured = _capture_generate_payload(monkeypatch)
    assert captured["json"]["language_code"] == "ko"


def test_payload_includes_speed(monkeypatch):
    captured = _capture_generate_payload(monkeypatch, speed=1.3)
    assert captured["json"]["voice_settings"]["speed"] == 1.3


def test_breath_tokens_passed_through_to_v3(monkeypatch):
    captured = _capture_generate_payload(
        monkeypatch,
        text="첫 문단 [breath] 두 번째 문단",
    )
    assert "[breath]" in captured["json"]["text"]
