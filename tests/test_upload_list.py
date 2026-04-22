"""GET /api/upload/list — server-side file picker bypass for DLP/VPN environments."""
from __future__ import annotations

import os

import pytest


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

    c = TestClient(app_module.app)
    c._uploads = uploads
    return c


def _touch(path, content=b"x"):
    path.write_bytes(content)


def test_list_image_returns_only_image_extensions(client):
    uploads = client._uploads
    _touch(uploads / "a.png")
    _touch(uploads / "b.jpg")
    _touch(uploads / "c.webp")
    _touch(uploads / "skip.txt")
    _touch(uploads / "skip.wav")

    r = client.get("/api/upload/list?kind=image")
    assert r.status_code == 200
    names = {f["filename"] for f in r.json()["files"]}
    assert names == {"a.png", "b.jpg", "c.webp"}


def test_list_audio_returns_only_audio_extensions(client):
    uploads = client._uploads
    _touch(uploads / "voice.wav")
    _touch(uploads / "song.mp3")
    _touch(uploads / "clip.m4a")
    _touch(uploads / "image.png")

    r = client.get("/api/upload/list?kind=audio")
    assert r.status_code == 200
    names = {f["filename"] for f in r.json()["files"]}
    assert names == {"voice.wav", "song.mp3", "clip.m4a"}


def test_list_default_kind_is_image(client):
    uploads = client._uploads
    _touch(uploads / "p.png")
    _touch(uploads / "v.wav")

    r = client.get("/api/upload/list")
    assert r.status_code == 200
    names = {f["filename"] for f in r.json()["files"]}
    assert names == {"p.png"}


def test_list_sorted_newest_first(client):
    uploads = client._uploads
    older = uploads / "old.png"
    newer = uploads / "new.png"
    _touch(older)
    _touch(newer)
    os.utime(older, (1_000_000, 1_000_000))
    os.utime(newer, (2_000_000, 2_000_000))

    r = client.get("/api/upload/list?kind=image")
    files = r.json()["files"]
    assert files[0]["filename"] == "new.png"
    assert files[1]["filename"] == "old.png"


def test_list_caps_at_200(client):
    uploads = client._uploads
    for i in range(205):
        _touch(uploads / f"f{i:03d}.png")

    r = client.get("/api/upload/list?kind=image")
    assert r.status_code == 200
    assert len(r.json()["files"]) == 200


def test_list_returns_empty_when_uploads_dir_missing(client, monkeypatch, tmp_path):
    import config
    monkeypatch.setattr(config, "UPLOADS_DIR", str(tmp_path / "does-not-exist"))

    r = client.get("/api/upload/list?kind=image")
    assert r.status_code == 200
    assert r.json() == {"files": []}
