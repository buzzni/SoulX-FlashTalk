"""User-scoping for ElevenLabs voice endpoints.

After /api/elevenlabs/voices and /api/elevenlabs/clone-voice were left
unauthenticated, the entire workspace's cloned voices were visible to
every user. These tests pin the new behavior:
- /voices returns shared stock + this user's cloned only
- /clone-voice records (user_id, voice_id) on success
- /generate refuses cross-user voice_ids
- /api/generate (audio_source=elevenlabs) and /api/generate-conversation
  apply the same check on their voice_id form fields
- DELETE /voices/{voice_id} is owner-scoped + refuses stock voices
"""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest


@pytest.fixture
def client(monkeypatch, tmp_path):
    """TestClient with patched config + stubbed ElevenLabs SDK.

    DB cleanup is handled by conftest's autouse `_bypass_studio_auth`
    fixture (it drops `studio_*` and `users` for each test) — we add
    `elevenlabs_voices` to the cleanup here.
    """
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

    # Drop the per-test elevenlabs_voices collection from any prior run.
    from pymongo import MongoClient
    pre = MongoClient("mongodb://localhost:27017", serverSelectionTimeoutMS=2000)
    test_db = pre[config.DB_NAME]
    if "elevenlabs_voices" in test_db.list_collection_names():
        test_db["elevenlabs_voices"].drop()
    pre.close()

    from fastapi.testclient import TestClient
    import app as app_module
    # Pre-seed the stock cache deterministically so list responses are
    # predictable. Tests that want to vary it call cache.invalidate().
    app_module._elevenlabs_stock_cache.invalidate()
    fake_workspace = [
        {"voice_id": "stock-1", "name": "Stock A", "category": "premade",
         "labels": {}, "preview_url": "", "description": ""},
        {"voice_id": "stock-2", "name": "Stock B", "category": "professional",
         "labels": {}, "preview_url": "", "description": ""},
    ]
    monkeypatch.setattr(
        "modules.elevenlabs_tts.ElevenLabsTTS.list_voices",
        lambda self: list(fake_workspace),
    )

    with TestClient(app_module.app) as c:
        yield c
        app_module._elevenlabs_stock_cache.invalidate()


def _set_user(monkeypatch, user_id: str, role: str = "member"):
    """Override the auth bypass with a custom user for this call."""
    fake = {
        "user_id": user_id,
        "display_name": user_id,
        "role": role,
        "is_active": True,
        "approval_status": "approved",
        "subscriptions": ["platform", "studio"],
        "studio_token_version": 0,
        "hashed_password": "",
    }

    async def _bypass(req, call_next):
        req.state.user = fake
        return await call_next(req)

    monkeypatch.setattr("modules.auth.auth_middleware", _bypass)


# ── /api/elevenlabs/voices ────────────────────────────────────────────


def test_list_returns_stock_plus_user_cloned(client, monkeypatch):
    """Bob's cloned voice belongs to bob; alice should only see stock."""
    # Seed bob's voice
    _set_user(monkeypatch, "bob")
    with patch("modules.elevenlabs_tts.ElevenLabsTTS.clone_voice", return_value="bob-clone"), \
         patch("modules.elevenlabs_tts.ElevenLabsTTS.get_voice",
               return_value={"voice_id": "bob-clone", "name": "Bob Voice",
                             "category": "cloned", "labels": {}, "preview_url": "",
                             "description": ""}):
        r = client.post(
            "/api/elevenlabs/clone-voice",
            data={"name": "Bob Voice"},
            files={"file": ("ref.wav", b"fakewav", "audio/wav")},
        )
    assert r.status_code == 200, r.text

    # Now alice asks for /voices: she should NOT see bob-clone
    _set_user(monkeypatch, "alice")
    r = client.get("/api/elevenlabs/voices")
    assert r.status_code == 200
    voice_ids = [v["voice_id"] for v in r.json()["voices"]]
    assert "stock-1" in voice_ids
    assert "stock-2" in voice_ids
    assert "bob-clone" not in voice_ids

    # Bob should see stock + his own
    _set_user(monkeypatch, "bob")
    r = client.get("/api/elevenlabs/voices")
    assert r.status_code == 200
    voice_ids = [v["voice_id"] for v in r.json()["voices"]]
    assert "bob-clone" in voice_ids
    assert "stock-1" in voice_ids


def test_clone_voice_persists_owner(client, monkeypatch):
    _set_user(monkeypatch, "alice")
    with patch("modules.elevenlabs_tts.ElevenLabsTTS.clone_voice", return_value="alice-clone"), \
         patch("modules.elevenlabs_tts.ElevenLabsTTS.get_voice",
               return_value={"voice_id": "alice-clone", "name": "Alice Voice",
                             "category": "cloned", "labels": {"lang": "ko"},
                             "preview_url": "https://x", "description": "d"}):
        r = client.post(
            "/api/elevenlabs/clone-voice",
            data={"name": "Alice Voice"},
            files={"file": ("ref.wav", b"fakewav", "audio/wav")},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["voice_id"] == "alice-clone"
    assert body["name"] == "Alice Voice"

    # And alice now has it in /voices
    r = client.get("/api/elevenlabs/voices")
    voice_ids = [v["voice_id"] for v in r.json()["voices"]]
    assert "alice-clone" in voice_ids


# ── /api/elevenlabs/generate ──────────────────────────────────────────


def test_generate_with_stock_voice_allowed(client, monkeypatch):
    _set_user(monkeypatch, "alice")
    with patch("modules.elevenlabs_tts.ElevenLabsTTS.generate_speech",
               side_effect=lambda **kw: _write_wav(kw["output_path"])):
        r = client.post(
            "/api/elevenlabs/generate",
            data={"text": "안녕", "voice_id": "stock-1"},
        )
    assert r.status_code == 200, r.text


def test_generate_with_owned_clone_allowed(client, monkeypatch):
    # alice clones, then alice generates with her own voice
    _set_user(monkeypatch, "alice")
    with patch("modules.elevenlabs_tts.ElevenLabsTTS.clone_voice", return_value="alice-c"), \
         patch("modules.elevenlabs_tts.ElevenLabsTTS.get_voice",
               return_value={"voice_id": "alice-c", "name": "x", "category": "cloned",
                             "labels": {}, "preview_url": "", "description": ""}):
        client.post("/api/elevenlabs/clone-voice", data={"name": "x"},
                    files={"file": ("r.wav", b"f", "audio/wav")})
    with patch("modules.elevenlabs_tts.ElevenLabsTTS.generate_speech",
               side_effect=lambda **kw: _write_wav(kw["output_path"])):
        r = client.post(
            "/api/elevenlabs/generate",
            data={"text": "안녕", "voice_id": "alice-c"},
        )
    assert r.status_code == 200, r.text


def test_generate_with_foreign_clone_404(client, monkeypatch):
    # bob clones a voice
    _set_user(monkeypatch, "bob")
    with patch("modules.elevenlabs_tts.ElevenLabsTTS.clone_voice", return_value="bob-c"), \
         patch("modules.elevenlabs_tts.ElevenLabsTTS.get_voice",
               return_value={"voice_id": "bob-c", "name": "x", "category": "cloned",
                             "labels": {}, "preview_url": "", "description": ""}):
        client.post("/api/elevenlabs/clone-voice", data={"name": "x"},
                    files={"file": ("r.wav", b"f", "audio/wav")})

    # alice tries to generate with bob's voice — 404 (don't leak existence)
    _set_user(monkeypatch, "alice")
    r = client.post(
        "/api/elevenlabs/generate",
        data={"text": "안녕", "voice_id": "bob-c"},
    )
    assert r.status_code == 404


def test_generate_with_unknown_voice_404(client, monkeypatch):
    _set_user(monkeypatch, "alice")
    r = client.post(
        "/api/elevenlabs/generate",
        data={"text": "안녕", "voice_id": "ghost-id"},
    )
    assert r.status_code == 404


# ── /api/generate (audio_source=elevenlabs) bypass guard ───────────────


def test_api_generate_elevenlabs_branch_blocks_foreign_voice(client, monkeypatch):
    """The bigger leak: /api/generate also accepts voice_id when
    audio_source='elevenlabs'. Prior to this fix it bypassed the
    /api/elevenlabs/generate ownership check entirely."""
    # bob has a clone
    _set_user(monkeypatch, "bob")
    with patch("modules.elevenlabs_tts.ElevenLabsTTS.clone_voice", return_value="bob-c"), \
         patch("modules.elevenlabs_tts.ElevenLabsTTS.get_voice",
               return_value={"voice_id": "bob-c", "name": "x", "category": "cloned",
                             "labels": {}, "preview_url": "", "description": ""}):
        client.post("/api/elevenlabs/clone-voice", data={"name": "x"},
                    files={"file": ("r.wav", b"f", "audio/wav")})

    # alice tries to use bob's voice via /api/generate
    _set_user(monkeypatch, "alice")
    r = client.post(
        "/api/generate",
        data={
            "audio_source": "elevenlabs",
            "script_text": "hi",
            "voice_id": "bob-c",
        },
    )
    assert r.status_code == 404


def test_api_generate_elevenlabs_branch_allows_stock_voice(client, monkeypatch):
    """Stock voices remain usable from /api/generate too — the security
    fix shouldn't break the ordinary path."""
    _set_user(monkeypatch, "alice")
    # We don't need a real generate to succeed past the validate gate;
    # stub generate_speech so the endpoint can finish enqueuing.
    with patch("modules.elevenlabs_tts.ElevenLabsTTS.generate_speech",
               side_effect=lambda **kw: _write_wav(kw["output_path"])):
        r = client.post(
            "/api/generate",
            data={
                "audio_source": "elevenlabs",
                "script_text": "hi",
                "voice_id": "stock-1",
            },
        )
    # Past the validate gate; the call should go through to enqueue.
    # Status 200 means enqueue happened.
    assert r.status_code == 200, r.text


# ── /api/generate-conversation bypass guard ────────────────────────────


def test_api_generate_conversation_blocks_foreign_voice_in_dialog(client, monkeypatch):
    """dialog_data.agents[*].voice_id was unchecked — same back-door."""
    _set_user(monkeypatch, "bob")
    with patch("modules.elevenlabs_tts.ElevenLabsTTS.clone_voice", return_value="bob-c"), \
         patch("modules.elevenlabs_tts.ElevenLabsTTS.get_voice",
               return_value={"voice_id": "bob-c", "name": "x", "category": "cloned",
                             "labels": {}, "preview_url": "", "description": ""}):
        client.post("/api/elevenlabs/clone-voice", data={"name": "x"},
                    files={"file": ("r.wav", b"f", "audio/wav")})

    _set_user(monkeypatch, "alice")
    import json as _json
    dialog_data = _json.dumps({
        "agents": [
            {"id": "a1", "voice_id": "stock-1"},
            {"id": "a2", "voice_id": "bob-c"},  # ← alien
        ],
        "dialog": [{"agent_id": "a1", "text": "hi"}],
    })
    r = client.post(
        "/api/generate-conversation",
        data={"dialog_data": dialog_data},
    )
    assert r.status_code == 404


# ── DELETE /api/elevenlabs/voices/{id} ────────────────────────────────


def test_delete_owner_succeeds(client, monkeypatch):
    _set_user(monkeypatch, "alice")
    with patch("modules.elevenlabs_tts.ElevenLabsTTS.clone_voice", return_value="alice-c"), \
         patch("modules.elevenlabs_tts.ElevenLabsTTS.get_voice",
               return_value={"voice_id": "alice-c", "name": "x", "category": "cloned",
                             "labels": {}, "preview_url": "", "description": ""}):
        client.post("/api/elevenlabs/clone-voice", data={"name": "x"},
                    files={"file": ("r.wav", b"f", "audio/wav")})

    with patch("modules.elevenlabs_tts.ElevenLabsTTS.delete_voice", return_value=True):
        r = client.delete("/api/elevenlabs/voices/alice-c")
    assert r.status_code == 200
    assert r.json()["ok"] is True

    # gone from list
    r = client.get("/api/elevenlabs/voices")
    voice_ids = [v["voice_id"] for v in r.json()["voices"]]
    assert "alice-c" not in voice_ids


def test_delete_foreign_returns_404(client, monkeypatch):
    _set_user(monkeypatch, "bob")
    with patch("modules.elevenlabs_tts.ElevenLabsTTS.clone_voice", return_value="bob-c"), \
         patch("modules.elevenlabs_tts.ElevenLabsTTS.get_voice",
               return_value={"voice_id": "bob-c", "name": "x", "category": "cloned",
                             "labels": {}, "preview_url": "", "description": ""}):
        client.post("/api/elevenlabs/clone-voice", data={"name": "x"},
                    files={"file": ("r.wav", b"f", "audio/wav")})

    _set_user(monkeypatch, "alice")
    r = client.delete("/api/elevenlabs/voices/bob-c")
    assert r.status_code == 404


def test_delete_stock_voice_403(client, monkeypatch):
    _set_user(monkeypatch, "alice")
    r = client.delete("/api/elevenlabs/voices/stock-1")
    assert r.status_code == 403


def test_delete_unknown_voice_404(client, monkeypatch):
    _set_user(monkeypatch, "alice")
    r = client.delete("/api/elevenlabs/voices/ghost-id")
    assert r.status_code == 404


def test_delete_admin_can_delete_others_clone(client, monkeypatch):
    _set_user(monkeypatch, "bob")
    with patch("modules.elevenlabs_tts.ElevenLabsTTS.clone_voice", return_value="bob-c"), \
         patch("modules.elevenlabs_tts.ElevenLabsTTS.get_voice",
               return_value={"voice_id": "bob-c", "name": "x", "category": "cloned",
                             "labels": {}, "preview_url": "", "description": ""}):
        client.post("/api/elevenlabs/clone-voice", data={"name": "x"},
                    files={"file": ("r.wav", b"f", "audio/wav")})

    _set_user(monkeypatch, "admin", role="admin")
    with patch("modules.elevenlabs_tts.ElevenLabsTTS.delete_voice", return_value=True):
        r = client.delete("/api/elevenlabs/voices/bob-c")
    assert r.status_code == 200


# ── helpers ───────────────────────────────────────────────────────────


def _write_wav(output_path: str) -> str:
    import wave
    with wave.open(output_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00" * 800)
    return output_path
