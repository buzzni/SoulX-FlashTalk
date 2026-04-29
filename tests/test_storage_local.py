"""Tests for modules.storage.LocalDiskMediaStore (PR3 + PR S3+)."""
from __future__ import annotations

import warnings
from datetime import datetime, timezone
from pathlib import Path

import pytest

import config
from modules.storage import (
    LocalDiskMediaStore,
    MediaStore,
    media_store,
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


# ── Protocol structural-subtyping ─────────────────────────────────────

def test_local_disk_satisfies_media_store_protocol():
    """LocalDiskMediaStore must structurally satisfy the MediaStore Protocol.

    Catches accidental signature drift between Protocol and impl —
    without this, mypy/pyright is the only safety net and we don't run
    static checks in CI yet."""
    store: MediaStore = LocalDiskMediaStore()  # noqa: F841 — type-check only


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


# ── _validate_and_resolve (internal) — replaces deprecated local_path_for ──

def test_validate_and_resolve_resolves_correctly(isolated_dirs):
    _, _, outputs, _ = isolated_dirs
    store = LocalDiskMediaStore()
    p = store._validate_and_resolve("outputs/hosts/saved/x.png")
    assert p == outputs / "hosts" / "saved" / "x.png"


def test_validate_and_resolve_does_not_double_apply_bucket(isolated_dirs):
    """Bucket dir must not be applied twice (codex N2 regression)."""
    _, _, outputs, _ = isolated_dirs
    store = LocalDiskMediaStore()
    p = store._validate_and_resolve("outputs/foo.png")
    assert p == outputs / "foo.png"
    assert "outputs/outputs" not in str(p)


def test_validate_and_resolve_rejects_unknown_bucket(isolated_dirs):
    store = LocalDiskMediaStore()
    with pytest.raises(ValueError, match="unknown bucket"):
        store._validate_and_resolve("garbage/foo.png")


def test_validate_and_resolve_rejects_traversal(isolated_dirs):
    store = LocalDiskMediaStore()
    for bad in (
        "outputs/../etc/passwd",
        "outputs/x/../y",
        "uploads/../outputs/foo",
        "outputs//foo.png",
    ):
        with pytest.raises(ValueError):
            store._validate_and_resolve(bad)


def test_validate_and_resolve_rejects_no_bucket(isolated_dirs):
    store = LocalDiskMediaStore()
    with pytest.raises(ValueError, match="bucket-prefixed"):
        store._validate_and_resolve("foo.png")


# ── url_for ──

def test_url_for_returns_api_files_path(isolated_dirs):
    store = LocalDiskMediaStore()
    assert store.url_for("outputs/foo.png") == "/api/files/outputs/foo.png"


def test_url_for_validates_key(isolated_dirs):
    store = LocalDiskMediaStore()
    with pytest.raises(ValueError):
        store.url_for("foo.png")
    with pytest.raises(ValueError):
        store.url_for("outputs/../../etc")


def test_url_for_ignores_expires_in_on_local(isolated_dirs):
    store = LocalDiskMediaStore()
    assert store.url_for("outputs/v.mp4", expires_in=21600) == "/api/files/outputs/v.mp4"
    assert store.url_for("outputs/v.mp4", expires_in=0) == "/api/files/outputs/v.mp4"


def test_url_for_with_download_filename_emits_query(isolated_dirs):
    """LocalDisk url_for must encode download_filename as a query param so
    /api/files/ can decorate Content-Disposition. S3 backend will sign it
    via ResponseContentDisposition instead — same caller contract."""
    store = LocalDiskMediaStore()
    url = store.url_for("outputs/v.mp4", download_filename="my video.mp4")
    assert url == "/api/files/outputs/v.mp4?download_filename=my%20video.mp4"


def test_url_for_download_filename_url_encodes_special_chars(isolated_dirs):
    store = LocalDiskMediaStore()
    url = store.url_for("outputs/v.mp4", download_filename="a/b?c.mp4")
    assert "download_filename=a%2Fb%3Fc.mp4" in url


# ── delete ──

def test_delete_existing_returns_true(isolated_dirs):
    store = LocalDiskMediaStore()
    key = store.save_bytes("hosts", b"x", basename="h.png")
    assert store.delete(key) is True
    assert store.delete(key) is False  # second time: file already gone


def test_unknown_kind_raises(isolated_dirs):
    store = LocalDiskMediaStore()
    with pytest.raises(ValueError, match="unknown media kind"):
        store.save_bytes("nonsense", b"x")


# ── PR S3+ key-based API ──────────────────────────────────────────

def test_upload_writes_file(isolated_dirs, tmp_path):
    _, _, outputs, _ = isolated_dirs
    src = tmp_path / "src.mp4"
    src.write_bytes(b"video-bytes")
    store = LocalDiskMediaStore()
    store.upload(src, "outputs/result.mp4")
    assert (outputs / "result.mp4").read_bytes() == b"video-bytes"
    assert src.exists(), "upload must not move the source"


def test_upload_creates_parent_dirs(isolated_dirs, tmp_path):
    _, _, outputs, _ = isolated_dirs
    src = tmp_path / "src.png"
    src.write_bytes(b"x")
    store = LocalDiskMediaStore()
    store.upload(src, "outputs/hosts/saved/nested/host_x.png")
    assert (outputs / "hosts" / "saved" / "nested" / "host_x.png").read_bytes() == b"x"


def test_upload_rejects_invalid_key(isolated_dirs, tmp_path):
    src = tmp_path / "src.png"
    src.write_bytes(b"x")
    store = LocalDiskMediaStore()
    with pytest.raises(ValueError):
        store.upload(src, "garbage/foo.png")


def test_upload_overwrites_existing(isolated_dirs, tmp_path):
    """Re-uploading the same key must replace the existing file."""
    _, _, outputs, _ = isolated_dirs
    store = LocalDiskMediaStore()
    src1 = tmp_path / "v1.mp4"
    src1.write_bytes(b"first")
    store.upload(src1, "outputs/x.mp4")
    src2 = tmp_path / "v2.mp4"
    src2.write_bytes(b"second-much-longer")
    store.upload(src2, "outputs/x.mp4")
    assert (outputs / "x.mp4").read_bytes() == b"second-much-longer"


def test_upload_atomic_no_tmp_leftover(isolated_dirs, tmp_path):
    """upload() uses tempfile + os.replace; no .tmp-* leftovers in the
    bucket dir on success."""
    _, _, outputs, _ = isolated_dirs
    src = tmp_path / "src.png"
    src.write_bytes(b"x")
    store = LocalDiskMediaStore()
    store.upload(src, "outputs/clean.png")
    leftovers = [p for p in outputs.iterdir() if p.name.startswith(".tmp-")]
    assert leftovers == []


def test_upload_same_file_no_op(isolated_dirs):
    """If `src` and the destination of `key` are the same file, upload
    must be a silent no-op (S3-parity wrapper that re-uploads)."""
    _, _, outputs, _ = isolated_dirs
    target = outputs / "x.mp4"
    target.write_bytes(b"original")
    store = LocalDiskMediaStore()
    store.upload(target, "outputs/x.mp4")
    assert target.read_bytes() == b"original"


def test_upload_empty_file(isolated_dirs, tmp_path):
    _, _, outputs, _ = isolated_dirs
    src = tmp_path / "empty.bin"
    src.write_bytes(b"")
    store = LocalDiskMediaStore()
    store.upload(src, "outputs/empty.bin")
    assert (outputs / "empty.bin").read_bytes() == b""


def test_download_to_copies_file(isolated_dirs, tmp_path):
    _, uploads, _, _ = isolated_dirs
    (uploads / "input.wav").write_bytes(b"audio")
    store = LocalDiskMediaStore()
    dst = tmp_path / "subdir" / "audio.wav"
    store.download_to("uploads/input.wav", dst)
    assert dst.read_bytes() == b"audio"


def test_download_to_missing_raises(isolated_dirs, tmp_path):
    store = LocalDiskMediaStore()
    with pytest.raises(FileNotFoundError):
        store.download_to("uploads/nope.wav", tmp_path / "x.wav")


def test_open_local_yields_path(isolated_dirs):
    _, uploads, _, _ = isolated_dirs
    (uploads / "host.png").write_bytes(b"img")
    store = LocalDiskMediaStore()
    with store.open_local("uploads/host.png") as path:
        assert path == uploads / "host.png"
        assert path.read_bytes() == b"img"


def test_open_local_no_cleanup_on_local_disk(isolated_dirs):
    """LocalDisk's open_local does NOT delete the file on exit. The S3
    backend will (and tests for that race live in test_storage_s3.py)."""
    _, uploads, _, _ = isolated_dirs
    (uploads / "host.png").write_bytes(b"img")
    store = LocalDiskMediaStore()
    with store.open_local("uploads/host.png"):
        pass
    assert (uploads / "host.png").exists(), "local file must survive ctx exit"


def test_open_local_missing_raises(isolated_dirs):
    store = LocalDiskMediaStore()
    with pytest.raises(FileNotFoundError):
        with store.open_local("uploads/missing.png"):
            pass


# ── head ──

def test_head_returns_size_etag_and_datetime(isolated_dirs):
    _, _, outputs, _ = isolated_dirs
    (outputs / "v.mp4").write_bytes(b"hello world")
    store = LocalDiskMediaStore()
    h = store.head("outputs/v.mp4")
    assert h["ContentLength"] == len(b"hello world")
    assert isinstance(h["LastModified"], datetime)
    assert h["LastModified"].tzinfo is not None, "LastModified must be tz-aware"
    # Weak ETag format: W/"<size>-<mtime_int>" — S3 will return quoted MD5
    # but callers compare via If-None-Match semantics, not byte equality.
    assert h["ETag"].startswith('W/"')
    assert h["ETag"].endswith('"')
    assert str(h["ContentLength"]) in h["ETag"]


def test_head_missing_raises(isolated_dirs):
    store = LocalDiskMediaStore()
    with pytest.raises(FileNotFoundError):
        store.head("outputs/missing.mp4")


def test_head_empty_file(isolated_dirs):
    _, _, outputs, _ = isolated_dirs
    (outputs / "empty.bin").write_bytes(b"")
    store = LocalDiskMediaStore()
    h = store.head("outputs/empty.bin")
    assert h["ContentLength"] == 0


# ── exists (strict — invalid key raises) ──

def test_exists_true_false(isolated_dirs):
    _, uploads, _, _ = isolated_dirs
    (uploads / "a.png").write_bytes(b"x")
    store = LocalDiskMediaStore()
    assert store.exists("uploads/a.png") is True
    assert store.exists("uploads/b.png") is False


def test_exists_invalid_key_raises(isolated_dirs):
    """Invalid keys (unknown bucket, traversal, missing slash, empty)
    must RAISE, not silently return False — silent False hides typos."""
    store = LocalDiskMediaStore()
    with pytest.raises(ValueError):
        store.exists("garbage/foo.png")
    with pytest.raises(ValueError):
        store.exists("foo.png")
    with pytest.raises(ValueError):
        store.exists("")
    with pytest.raises(ValueError):
        store.exists("outputs/../etc")


# ── list_prefix ──

def test_list_prefix_returns_matching_keys(isolated_dirs):
    _, uploads, _, _ = isolated_dirs
    (uploads / "a.png").write_bytes(b"1")
    (uploads / "b.png").write_bytes(b"22")
    store = LocalDiskMediaStore()
    entries = store.list_prefix("uploads/")
    keys = [e["Key"] for e in entries]
    assert keys == ["uploads/a.png", "uploads/b.png"]
    sizes = {e["Key"]: e["Size"] for e in entries}
    assert sizes["uploads/a.png"] == 1
    assert sizes["uploads/b.png"] == 2


def test_list_prefix_returns_sorted_by_key(isolated_dirs):
    """Order contract: results must be lexicographically sorted by Key
    (S3 listing order). Tests must not need sorted() to compare."""
    _, uploads, _, _ = isolated_dirs
    for name in ("zeta.png", "alpha.png", "mid.png"):
        (uploads / name).write_bytes(b"x")
    store = LocalDiskMediaStore()
    keys = [e["Key"] for e in store.list_prefix("uploads/")]
    assert keys == ["uploads/alpha.png", "uploads/mid.png", "uploads/zeta.png"]


def test_list_prefix_lastmodified_is_datetime(isolated_dirs):
    _, uploads, _, _ = isolated_dirs
    (uploads / "a.png").write_bytes(b"x")
    store = LocalDiskMediaStore()
    entries = store.list_prefix("uploads/")
    assert isinstance(entries[0]["LastModified"], datetime)
    assert entries[0]["LastModified"].tzinfo is not None


def test_list_prefix_subprefix(isolated_dirs):
    _, _, outputs, _ = isolated_dirs
    (outputs / "hosts" / "saved").mkdir(parents=True)
    (outputs / "hosts" / "saved" / "h1.png").write_bytes(b"x")
    (outputs / "result.mp4").write_bytes(b"y")
    store = LocalDiskMediaStore()
    keys = [e["Key"] for e in store.list_prefix("outputs/hosts/")]
    assert keys == ["outputs/hosts/saved/h1.png"]


def test_list_prefix_empty_when_unknown_bucket(isolated_dirs):
    store = LocalDiskMediaStore()
    assert store.list_prefix("garbage/") == []
    assert store.list_prefix("") == []
    assert store.list_prefix("outputs") == []  # no slash


def test_list_prefix_does_not_follow_symlinks(isolated_dirs, tmp_path):
    """Symlinks inside a bucket must not be traversed — defense against
    accidental escape of the bucket boundary."""
    _, uploads, _, _ = isolated_dirs
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_bytes(b"oops")
    # Symlink inside uploads/ pointing to outside dir.
    (uploads / "linked").symlink_to(outside)
    store = LocalDiskMediaStore()
    keys = [e["Key"] for e in store.list_prefix("uploads/")]
    assert "uploads/linked/secret.txt" not in keys
