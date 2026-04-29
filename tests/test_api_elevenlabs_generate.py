"""POST /api/elevenlabs/generate — TTS endpoint integration.

Regression coverage for the Step 3 audio preview bug (April 2026):
- TTS used to write to TEMP_DIR which is NOT in SAFE_ROOTS, so the
  /api/files/{name} preview lookup 404'd.
- Endpoint also returned only `path` (filesystem absolute path); the
  frontend then concatenated it into a URL like
  `/api/files//opt/.../temp/tts_xxx.wav` — two bugs deep.

The fix: write to OUTPUTS_DIR + return a relative `url` field for the
frontend to use as <audio src>.
"""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest


@pytest.fixture
def client(monkeypatch, tmp_path):
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    examples = tmp_path / "examples"
    temp_dir = tmp_path / "temp"
    for d in (uploads, outputs, examples, temp_dir):
        d.mkdir(parents=True, exist_ok=True)

    import config
    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(examples))
    monkeypatch.setattr(config, "TEMP_DIR", str(temp_dir))
    monkeypatch.setattr(config, "SAFE_ROOTS", (str(uploads), str(outputs), str(examples)))
    monkeypatch.setattr(config, "ELEVENLABS_API_KEY", "test-key")

    from fastapi.testclient import TestClient
    import app as app_module
    with TestClient(app_module.app) as c:
        yield c


def _stub_generate_speech(text, voice_id, output_path, **kw):
    """Write a tiny valid WAV so /api/files/ can serve it."""
    import wave
    with wave.open(output_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00" * 800)
    return output_path


def test_tts_writes_to_outputs_and_returns_serveable_url(client):
    import config
    with patch(
        "modules.elevenlabs_tts.ElevenLabsTTS.generate_speech",
        side_effect=_stub_generate_speech,
    ):
        r = client.post(
            "/api/elevenlabs/generate",
            data={"text": "안녕", "voice_id": "v1"},
        )

    assert r.status_code == 200, r.text
    body = r.json()
    # PR-4 canonical shape: {filename, key, url}
    assert "filename" in body
    assert "key" in body, "frontend round-trips this back to /api/*/generate"
    assert "url" in body, "frontend renders <audio src=url>"
    assert "path" not in body, "PR-4 dropped legacy `path` field"
    assert "storage_key" not in body, "PR-4 renamed storage_key → key"
    assert body["key"] == f"outputs/{body['filename']}"

    # URL is relative through /api/files/ so the Vite proxy can route it.
    assert body["url"] == f"/api/files/{body['key']}"
    assert not body["url"].startswith("http")  # no host/port hardcoded

    # And /api/files/ actually serves it
    fetched = client.get(body["url"])
    assert fetched.status_code == 200
    assert fetched.headers["content-type"] == "audio/wav"
    assert len(fetched.content) > 0


def test_tts_rejects_missing_api_key(client, monkeypatch):
    import config
    monkeypatch.setattr(config, "ELEVENLABS_API_KEY", "")
    r = client.post(
        "/api/elevenlabs/generate",
        data={"text": "안녕", "voice_id": "v1"},
    )
    assert r.status_code == 400
    assert "API key" in r.json()["detail"]


def test_tts_rejects_out_of_range_speed(client):
    r = client.post(
        "/api/elevenlabs/generate",
        data={"text": "안녕", "voice_id": "v1", "speed": "2.5"},
    )
    assert r.status_code == 400
    assert "speed" in r.json()["detail"]
