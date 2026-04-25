"""Tests for modules.storage.LocalDiskMediaStore (PR3)."""
from __future__ import annotations

from pathlib import Path

import pytest

import config
from modules.storage import (
    LocalDiskMediaStore,
    media_store,
    resolve_legacy_or_keyed,
)


@pytest.fixture
def isolated_dirs(tmp_path, monkeypatch):
    """Redirect bucket dirs to tmp_path so writes can't leak into the real repo."""
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    examples = tmp_path / "examples"
    for d in (uploads, outputs, examples):
        d.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(examples))
    monkeypatch.setattr(config, "SAFE_ROOTS", (str(uploads), str(outputs), str(examples)))
    return tmp_path, uploads, outputs, examples


def test_save_bytes_outputs_bucket(isolated_dirs):
    _, _, outputs, _ = isolated_dirs
    store = LocalDiskMediaStore()
    key = store.save_bytes("hosts", b"abc", suffix=".png", basename="host_x.png")
    assert key == "outputs/hosts/saved/host_x.png"
    assert (outputs / "hosts" / "saved" / "host_x.png").read_bytes() == b"abc"


def test_save_bytes_uploads_bucket(isolated_dirs):
    _, uploads, _, _ = isolated_dirs
    store = LocalDiskMediaStore()
    key = store.save_bytes("ref_images", b"xyz", basename="ref_a.png")
    assert key == "uploads/ref_a.png"
    assert (uploads / "ref_a.png").read_bytes() == b"xyz"


def test_save_bytes_auto_basename(isolated_dirs):
    store = LocalDiskMediaStore()
    key = store.save_bytes("hosts", b"q", suffix=".png")
    assert key.startswith("outputs/hosts/saved/")
    assert key.endswith(".png")


def test_save_path_copies_file(isolated_dirs, tmp_path):
    _, _, outputs, _ = isolated_dirs
    src = tmp_path / "src.png"
    src.write_bytes(b"hello")
    store = LocalDiskMediaStore()
    key = store.save_path("composites", src, basename="composite_x.png")
    assert key == "outputs/composites/composite_x.png"
    assert (outputs / "composites" / "composite_x.png").read_bytes() == b"hello"
    assert src.exists(), "source must remain (copy, not move)"


def test_local_path_for_resolves_correctly(isolated_dirs):
    _, _, outputs, _ = isolated_dirs
    store = LocalDiskMediaStore()
    p = store.local_path_for("outputs/hosts/saved/x.png")
    assert p == outputs / "hosts" / "saved" / "x.png"


def test_local_path_for_does_not_double_apply_bucket(isolated_dirs):
    """Codex N2 regression — bucket dir must not be applied twice."""
    _, _, outputs, _ = isolated_dirs
    store = LocalDiskMediaStore()
    p = store.local_path_for("outputs/foo.png")
    assert p == outputs / "foo.png"
    assert "outputs/outputs" not in str(p)


def test_local_path_for_rejects_unknown_bucket(isolated_dirs):
    store = LocalDiskMediaStore()
    with pytest.raises(ValueError, match="unknown bucket"):
        store.local_path_for("garbage/foo.png")


def test_local_path_for_rejects_traversal(isolated_dirs):
    store = LocalDiskMediaStore()
    for bad in (
        "outputs/../etc/passwd",
        "outputs/x/../y",
        "uploads/../outputs/foo",
        "outputs//foo.png",  # empty segment
    ):
        with pytest.raises(ValueError):
            store.local_path_for(bad)


def test_local_path_for_rejects_no_bucket(isolated_dirs):
    store = LocalDiskMediaStore()
    with pytest.raises(ValueError, match="bucket-prefixed"):
        store.local_path_for("foo.png")


def test_url_for_returns_api_files_path(isolated_dirs):
    store = LocalDiskMediaStore()
    assert store.url_for("outputs/foo.png") == "/api/files/outputs/foo.png"


def test_url_for_validates_key(isolated_dirs):
    store = LocalDiskMediaStore()
    with pytest.raises(ValueError):
        store.url_for("foo.png")
    with pytest.raises(ValueError):
        store.url_for("outputs/../../etc")


def test_delete_existing_returns_true(isolated_dirs):
    store = LocalDiskMediaStore()
    key = store.save_bytes("hosts", b"x", basename="h.png")
    assert store.delete(key) is True
    assert store.delete(key) is False  # second time: file already gone


def test_unknown_kind_raises(isolated_dirs):
    store = LocalDiskMediaStore()
    with pytest.raises(ValueError, match="unknown media kind"):
        store.save_bytes("nonsense", b"x")


# ── resolve_legacy_or_keyed ──

def test_resolve_legacy_or_keyed_new_style(isolated_dirs):
    _, _, outputs, _ = isolated_dirs
    (outputs / "hosts" / "saved").mkdir(parents=True, exist_ok=True)
    (outputs / "hosts" / "saved" / "h.png").write_bytes(b"x")
    p = resolve_legacy_or_keyed("outputs/hosts/saved/h.png")
    assert p is not None
    assert p.read_bytes() == b"x"


def test_resolve_legacy_or_keyed_legacy_under_outputs(isolated_dirs):
    _, _, outputs, _ = isolated_dirs
    (outputs / "hosts" / "saved").mkdir(parents=True, exist_ok=True)
    (outputs / "hosts" / "saved" / "h.png").write_bytes(b"x")
    # Legacy URL form: bucket missing
    p = resolve_legacy_or_keyed("hosts/saved/h.png")
    assert p is not None
    assert p.read_bytes() == b"x"


def test_resolve_legacy_or_keyed_legacy_under_uploads(isolated_dirs):
    _, uploads, _, _ = isolated_dirs
    (uploads / "ref.png").write_bytes(b"y")
    p = resolve_legacy_or_keyed("ref.png")
    assert p is not None
    assert p.read_bytes() == b"y"


def test_resolve_legacy_or_keyed_missing_returns_none(isolated_dirs):
    assert resolve_legacy_or_keyed("nope/missing.png") is None
    assert resolve_legacy_or_keyed("missing.png") is None
