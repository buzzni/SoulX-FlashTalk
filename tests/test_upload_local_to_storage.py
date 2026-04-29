"""Regression test: `_upload_local_to_storage` must return `key`, not
`storage_key`. The docstring used to mis-claim `storage_key`, and two
callers (`scene_prompt` Gemini promote, ElevenLabs `/api/generate`
branch) read the wrong key — `host_image_key_for_manifest` ended up
None and the audio path silently fell back to a temp absolute path.

Pin the response shape so a future rename is caught.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest


def test_upload_local_to_storage_returns_key_not_storage_key(
    monkeypatch, outputs_dir, tmp_path,
):
    """Response shape: {filename, key, url}. No `storage_key` field —
    callers reading `promoted.get("storage_key")` get None and quietly
    break."""
    monkeypatch.setattr("config.OUTPUTS_DIR", str(outputs_dir))

    import app as app_module

    # Place a file under outputs/ — LocalDisk backend will same-file
    # no-op the upload, which is exactly the path the production
    # ElevenLabs / scene_prompt callers exercise (write to OUTPUTS_DIR
    # then promote).
    src = Path(outputs_dir) / "tts_test.wav"
    src.write_bytes(b"fake wav")

    result = app_module._upload_local_to_storage(str(src), cleanup_local=False)

    assert isinstance(result, dict)
    assert "key" in result, f"missing 'key' in {result.keys()}"
    assert result["key"] == "outputs/tts_test.wav"
    assert "filename" in result
    assert "url" in result
    # Pin: the legacy field name is NOT present. If a future rename
    # adds it back, both names must be supported simultaneously.
    assert "storage_key" not in result
