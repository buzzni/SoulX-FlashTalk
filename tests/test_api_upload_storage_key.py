"""Smoke tests for the dual-compatible upload response shape (PR S3+ C5).

Each /api/upload/* endpoint must return:
    {
      "filename":    <basename>,
      "path":        <legacy field — absolute disk path on LocalDisk>,
      "storage_key": <bucket-prefixed key, e.g. "uploads/host_xxxx.png">,
      "url":         <served URL — /api/files/<key> on LocalDisk>,
      ...endpoint-specific extras
    }

Tests run against the LocalDisk backend (default). The same endpoints
will pick up the S3 backend automatically once C13 cutover lands; the
contract here is what frontend C9 will build against.
"""
from __future__ import annotations

import base64
import io
from pathlib import Path

import pytest
from PIL import Image


def _png_bytes() -> bytes:
    """Real 1x1 white PNG that passes Pillow's verify() check."""
    buf = io.BytesIO()
    Image.new("RGB", (1, 1), color="white").save(buf, format="PNG")
    return buf.getvalue()


_PNG_BYTES = _png_bytes()


@pytest.fixture
def client(monkeypatch, tmp_path):
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    examples = tmp_path / "examples"
    for d in (uploads, outputs, examples):
        d.mkdir(parents=True, exist_ok=True)

    import config

    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(examples))
    monkeypatch.setattr(config, "SAFE_ROOTS", (str(uploads), str(outputs), str(examples)))

    from fastapi.testclient import TestClient
    import app as app_module

    with TestClient(app_module.app) as test_client:
        test_client._uploads_dir = str(uploads)
        yield test_client


def _assert_response_shape(body: dict, *, key_prefix: str):
    """Verify the standard upload response shape."""
    assert "filename" in body, f"missing filename in {body}"
    assert "path" in body, f"missing path in {body}"
    assert "storage_key" in body, f"missing storage_key in {body}"
    assert "url" in body, f"missing url in {body}"
    assert body["storage_key"].startswith(key_prefix), \
        f"key {body['storage_key']!r} does not start with {key_prefix!r}"
    # url should serve the same key
    assert body["storage_key"] in body["url"], \
        f"url {body['url']!r} does not reference key {body['storage_key']!r}"
    # filename should match the key's basename
    assert body["filename"] == body["storage_key"].split("/")[-1]


def test_upload_host_image_returns_storage_key(client):
    files = {"file": ("test.png", _PNG_BYTES, "image/png")}
    r = client.post("/api/upload/host-image", files=files)
    assert r.status_code == 200, r.text
    body = r.json()
    _assert_response_shape(body, key_prefix="uploads/host_")
    # Backwards-compat: path on LocalDisk is the absolute filesystem path
    assert Path(body["path"]).exists()
    assert Path(body["path"]).read_bytes() == _PNG_BYTES


def test_upload_background_image_returns_storage_key(client):
    files = {"file": ("bg.png", _PNG_BYTES, "image/png")}
    r = client.post("/api/upload/background-image", files=files)
    assert r.status_code == 200, r.text
    _assert_response_shape(r.json(), key_prefix="uploads/bg_")


def test_upload_reference_image_returns_storage_key(client):
    files = {"file": ("ref.png", _PNG_BYTES, "image/png")}
    r = client.post("/api/upload/reference-image", files=files)
    assert r.status_code == 200, r.text
    _assert_response_shape(r.json(), key_prefix="uploads/ref_img_")


def test_upload_json_returns_storage_key(client):
    body = {
        "kind": "host-image",
        "filename": "test.png",
        "content_base64": base64.b64encode(_PNG_BYTES).decode(),
        "mime_type": "image/png",
    }
    r = client.post("/api/upload/json", json=body)
    assert r.status_code == 200, r.text
    payload = r.json()
    _assert_response_shape(payload, key_prefix="uploads/host_")
    # Endpoint-specific extras
    assert payload["kind"] == "host-image"
    assert payload["size"] == len(_PNG_BYTES)


def test_upload_rejects_oversize(client, monkeypatch):
    """Tempfile cleanup invariant: an over-size upload must NOT leave a
    file in the uploads dir (the legacy code wrote partial bytes before
    aborting and called os.unlink — the new tempfile-based path keeps
    the bucket clean automatically)."""
    import config
    monkeypatch.setattr(config, "MAX_UPLOAD_BYTES", 100)
    big = b"\x89PNG\r\n\x1a\n" + b"\x00" * 200
    files = {"file": ("big.png", big, "image/png")}
    r = client.post("/api/upload/host-image", files=files)
    assert r.status_code == 413
    # Bucket dir must be empty — no half-written file leaked through.
    uploads = Path(client._uploads_dir)
    assert list(uploads.iterdir()) == [], \
        f"uploads dir should be empty, got {[p.name for p in uploads.iterdir()]}"


def test_upload_rejects_invalid_image_does_not_leak(client):
    """A request that passes Content-Type but fails magic-byte
    validation must not leave anything in the bucket."""
    bad = b"this is not a png at all"
    files = {"file": ("evil.png", bad, "image/png")}
    r = client.post("/api/upload/host-image", files=files)
    assert r.status_code in (400, 422)  # validate_image_upload raises
    uploads = Path(client._uploads_dir)
    assert list(uploads.iterdir()) == [], \
        f"uploads dir should be empty, got {[p.name for p in uploads.iterdir()]}"


def test_upload_json_rejects_invalid_audio_does_not_leak(client):
    """Same invariant via the JSON / base64 path."""
    body = {
        "kind": "audio",
        "filename": "fake.wav",
        "content_base64": base64.b64encode(b"not really wav").decode(),
        "mime_type": "audio/wav",
    }
    r = client.post("/api/upload/json", json=body)
    assert r.status_code in (400, 422)
    uploads = Path(client._uploads_dir)
    assert list(uploads.iterdir()) == []
