"""Tests for utils.security.safe_input_value and the
app._resolve_input_to_local pair (PR S3+ C9 dual-input handling)."""
from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi import HTTPException


@pytest.fixture
def isolated_dirs(tmp_path, monkeypatch):
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
    return tmp_path, uploads, outputs, examples


# ── safe_input_value: dual shape ──────────────────────────────────

def test_safe_input_value_accepts_storage_key(isolated_dirs):
    from utils.security import safe_input_value
    assert safe_input_value("uploads/host_x.png") == "uploads/host_x.png"
    assert safe_input_value("outputs/v.mp4") == "outputs/v.mp4"
    assert safe_input_value("examples/woman.png") == "examples/woman.png"


def test_safe_input_value_accepts_absolute_path_inside_safe_roots(isolated_dirs):
    from utils.security import safe_input_value
    _, uploads, _, _ = isolated_dirs
    p = uploads / "host.png"
    p.write_bytes(b"x")
    out = safe_input_value(str(p))
    assert out == str(p.resolve())


def test_safe_input_value_rejects_storage_key_with_traversal(isolated_dirs):
    from utils.security import safe_input_value
    with pytest.raises(HTTPException) as exc:
        safe_input_value("uploads/../etc/passwd")
    assert exc.value.status_code == 400


def test_safe_input_value_rejects_unknown_bucket(isolated_dirs):
    """First segment that isn't a known bucket falls through to
    `safe_upload_path` which then fails on SAFE_ROOTS check."""
    from utils.security import safe_input_value
    with pytest.raises(HTTPException):
        safe_input_value("garbage/foo.png")


def test_safe_input_value_rejects_absolute_outside_safe_roots(isolated_dirs):
    from utils.security import safe_input_value
    with pytest.raises(HTTPException):
        safe_input_value("/etc/passwd")


def test_safe_input_value_rejects_empty(isolated_dirs):
    from utils.security import safe_input_value
    with pytest.raises(HTTPException):
        safe_input_value("")


# ── _resolve_input_to_local ───────────────────────────────────────

def test_resolve_input_storage_key_downloads_to_tempfile(isolated_dirs):
    from app import _resolve_input_to_local
    _, uploads, _, _ = isolated_dirs
    # Pre-populate the bucket the LocalDisk backend resolves to.
    src = uploads / "audio.wav"
    src.write_bytes(b"riff-content")

    cleanup: list[str] = []
    local = _resolve_input_to_local("uploads/audio.wav", cleanup)
    try:
        assert local is not None
        assert os.path.exists(local)
        assert Path(local).read_bytes() == b"riff-content"
        assert local in cleanup, "tempfile must be tracked for cleanup"
        assert local != str(src), "should be a separate temp copy"
    finally:
        for p in cleanup:
            try:
                os.unlink(p)
            except OSError:
                pass


def test_resolve_input_absolute_path_is_passthrough(isolated_dirs):
    from app import _resolve_input_to_local
    _, uploads, _, _ = isolated_dirs
    src = uploads / "host.png"
    src.write_bytes(b"x")
    cleanup: list[str] = []
    local = _resolve_input_to_local(str(src), cleanup)
    assert local == str(src), "absolute path should pass through unchanged"
    assert cleanup == [], "no temp files to clean for absolute paths"


def test_resolve_input_none(isolated_dirs):
    from app import _resolve_input_to_local
    cleanup: list[str] = []
    assert _resolve_input_to_local(None, cleanup) is None
    assert _resolve_input_to_local("", cleanup) is None
    assert cleanup == []


def test_cleanup_input_tempfiles_removes_all(isolated_dirs):
    """Cleanup helper unlinks every tracked tempfile and is tolerant
    of already-missing files."""
    from app import _cleanup_input_tempfiles
    import tempfile
    fd1, t1 = tempfile.mkstemp()
    os.close(fd1)
    fd2, t2 = tempfile.mkstemp()
    os.close(fd2)
    os.unlink(t2)  # pre-delete one to test tolerance
    _cleanup_input_tempfiles([t1, t2, "/nonexistent/x"])
    assert not os.path.exists(t1)
