"""Tests for modules.storage_s3.S3MediaStore (PR S3+).

Uses moto's `mock_aws` to mock S3 in-process — no AWS credentials or
network required. Each test gets a fresh bucket (function-scoped fixture)
so leaked objects can't bleed across tests.

Design parity with `tests/test_storage_local.py`:
    Where the same behaviour applies to both backends (e.g. `head()`
    returning a tz-aware datetime, `exists()` raising on invalid keys,
    `list_prefix()` returning sorted entries) the test here exercises
    the same contract — drop-in interchangeability is the goal.

S3-specific tests:
    - `open_local()` MUST unlink the temp file on context exit (the
      LocalDisk backend can't show this — see review-findings §4).
    - `url_for(download_filename=...)` signs `ResponseContentDisposition`
      into the presigned URL.
    - lazy client init: constructing without a real AWS connection or
      injected client doesn't crash.
"""
from __future__ import annotations

from datetime import datetime
from urllib.parse import parse_qs, unquote, urlparse

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from modules.storage import MediaStore
from modules.storage_s3 import S3MediaStore


BUCKET = "ailab-demo"
ENV = "dev"
PROJECT = "soulx-flashtalk"
ROOT = f"{ENV}/{PROJECT}"

# `s3_setup` fixture lives in tests/conftest.py (PR S3+ C4) so future
# S3-backed tests can share the same moto context. It yields
# `(s3_client, s3_media_store)` — same shape this file used to define
# locally.


# ── Protocol satisfaction ─────────────────────────────────────────────

def test_s3_satisfies_media_store_protocol():
    """S3MediaStore must structurally satisfy the MediaStore Protocol —
    mirror of `test_local_disk_satisfies_media_store_protocol`."""
    store: MediaStore = S3MediaStore(  # noqa: F841 — type-check only
        bucket=BUCKET,
        env_prefix=ENV,
        project=PROJECT,
        client=object(),  # placeholder, no AWS calls happen here
    )


def test_construction_does_not_call_aws():
    """Lazy client: building the store without `client=...` and without
    any AWS access must not crash. This is the contract that makes CI
    safe (no real credentials)."""
    store = S3MediaStore(
        bucket=BUCKET,
        env_prefix=ENV,
        project=PROJECT,
        access_key="ignored",
        secret_key="ignored",
        region="us-east-1",
    )
    assert store._client is None  # client built only on first use


def test_constructor_rejects_empty_required_fields():
    with pytest.raises(ValueError):
        S3MediaStore(bucket="", env_prefix=ENV, project=PROJECT, client=object())
    with pytest.raises(ValueError):
        S3MediaStore(bucket=BUCKET, env_prefix="", project=PROJECT, client=object())
    with pytest.raises(ValueError):
        S3MediaStore(bucket=BUCKET, env_prefix=ENV, project="", client=object())


# ── kind-based (parity) ────────────────────────────────────────────

def test_save_bytes_writes_to_s3_under_prefix(s3_setup):
    client, store = s3_setup
    key = store.save_bytes("hosts", b"abc", basename="host_x.png")
    assert key == "outputs/hosts/saved/host_x.png"
    obj = client.get_object(Bucket=BUCKET, Key=f"{ROOT}/{key}")
    assert obj["Body"].read() == b"abc"
    assert obj["ContentType"] == "image/png"


def test_save_bytes_auto_basename(s3_setup):
    _, store = s3_setup
    key = store.save_bytes("hosts", b"q", suffix=".png")
    assert key.startswith("outputs/hosts/saved/")
    assert key.endswith(".png")


def test_save_path_uploads(s3_setup, tmp_path):
    client, store = s3_setup
    src = tmp_path / "src.png"
    src.write_bytes(b"hello")
    key = store.save_path("composites", src, basename="composite_x.png")
    assert key == "outputs/composites/composite_x.png"
    obj = client.get_object(Bucket=BUCKET, Key=f"{ROOT}/{key}")
    assert obj["Body"].read() == b"hello"


def test_save_bytes_unknown_kind_raises(s3_setup):
    _, store = s3_setup
    with pytest.raises(ValueError, match="unknown media kind"):
        store.save_bytes("nonsense", b"x")


# ── upload / download_to ──────────────────────────────────────────

def test_upload_writes_object(s3_setup, tmp_path):
    client, store = s3_setup
    src = tmp_path / "result.mp4"
    src.write_bytes(b"video-bytes")
    store.upload(src, "outputs/result.mp4")
    obj = client.get_object(Bucket=BUCKET, Key=f"{ROOT}/outputs/result.mp4")
    assert obj["Body"].read() == b"video-bytes"
    assert obj["ContentType"] == "video/mp4"
    assert src.exists(), "upload must not move the source"


def test_upload_overwrites(s3_setup, tmp_path):
    client, store = s3_setup
    src1 = tmp_path / "v1.mp4"
    src1.write_bytes(b"first")
    store.upload(src1, "outputs/x.mp4")
    src2 = tmp_path / "v2.mp4"
    src2.write_bytes(b"second-much-longer")
    store.upload(src2, "outputs/x.mp4")
    obj = client.get_object(Bucket=BUCKET, Key=f"{ROOT}/outputs/x.mp4")
    assert obj["Body"].read() == b"second-much-longer"


def test_upload_empty_file(s3_setup, tmp_path):
    client, store = s3_setup
    src = tmp_path / "empty.bin"
    src.write_bytes(b"")
    store.upload(src, "outputs/empty.bin")
    obj = client.get_object(Bucket=BUCKET, Key=f"{ROOT}/outputs/empty.bin")
    assert obj["Body"].read() == b""
    assert obj["ContentLength"] == 0


def test_upload_rejects_invalid_key(s3_setup, tmp_path):
    _, store = s3_setup
    src = tmp_path / "x.png"
    src.write_bytes(b"x")
    with pytest.raises(ValueError):
        store.upload(src, "garbage/foo.png")


def test_download_to_copies(s3_setup, tmp_path):
    client, store = s3_setup
    client.put_object(Bucket=BUCKET, Key=f"{ROOT}/uploads/in.wav", Body=b"audio")
    dst = tmp_path / "subdir" / "audio.wav"
    store.download_to("uploads/in.wav", dst)
    assert dst.read_bytes() == b"audio"


def test_download_to_missing_raises_filenotfound(s3_setup, tmp_path):
    _, store = s3_setup
    with pytest.raises(FileNotFoundError):
        store.download_to("uploads/nope.wav", tmp_path / "x.wav")


# ── open_local — S3-side cleanup contract ────────────────────────

def test_open_local_yields_path_with_content(s3_setup):
    client, store = s3_setup
    client.put_object(Bucket=BUCKET, Key=f"{ROOT}/uploads/host.png", Body=b"img")
    with store.open_local("uploads/host.png") as path:
        assert path.exists()
        assert path.read_bytes() == b"img"


def test_open_local_unlinks_temp_on_exit(s3_setup):
    """The S3-side contract LocalDisk can't prove: temp file MUST be
    unlinked when the context exits normally."""
    client, store = s3_setup
    client.put_object(Bucket=BUCKET, Key=f"{ROOT}/uploads/host.png", Body=b"img")
    captured = []
    with store.open_local("uploads/host.png") as path:
        captured.append(path)
    # ctx exit → S3 backend MUST have unlinked the temp.
    assert not captured[0].exists()


def test_open_local_unlinks_temp_on_exception(s3_setup):
    """Even if the body of the `with` raises, cleanup must run (proves
    the unlink is in `finally`, not the success path)."""
    client, store = s3_setup
    client.put_object(Bucket=BUCKET, Key=f"{ROOT}/uploads/x.png", Body=b"x")
    captured = []
    with pytest.raises(RuntimeError):
        with store.open_local("uploads/x.png") as path:
            captured.append(path)
            raise RuntimeError("boom")
    assert not captured[0].exists()


def test_open_local_missing_raises(s3_setup):
    _, store = s3_setup
    with pytest.raises(FileNotFoundError):
        with store.open_local("uploads/missing.png"):
            pass


def test_open_local_invalid_key_raises_before_temp_created(s3_setup):
    _, store = s3_setup
    with pytest.raises(ValueError):
        with store.open_local("garbage/x.png"):
            pass


# ── head ──────────────────────────────────────────────────────────

def test_head_returns_size_etag_and_datetime(s3_setup):
    client, store = s3_setup
    client.put_object(Bucket=BUCKET, Key=f"{ROOT}/outputs/v.mp4", Body=b"hello world")
    h = store.head("outputs/v.mp4")
    assert h["ContentLength"] == len(b"hello world")
    assert isinstance(h["LastModified"], datetime)
    assert h["LastModified"].tzinfo is not None, "LastModified must be tz-aware"
    # S3 returns a quoted MD5 hex; LocalDisk returns weak W/"size-mtime".
    # Both are non-empty strings — callers compare via If-None-Match.
    assert isinstance(h["ETag"], str) and len(h["ETag"]) > 0


def test_head_missing_raises(s3_setup):
    _, store = s3_setup
    with pytest.raises(FileNotFoundError):
        store.head("outputs/missing.mp4")


# ── exists ────────────────────────────────────────────────────────

def test_exists_true_false(s3_setup):
    client, store = s3_setup
    client.put_object(Bucket=BUCKET, Key=f"{ROOT}/uploads/a.png", Body=b"x")
    assert store.exists("uploads/a.png") is True
    assert store.exists("uploads/b.png") is False


def test_exists_invalid_key_raises(s3_setup):
    """Strict parity with LocalDisk — invalid keys raise rather than
    silently returning False."""
    _, store = s3_setup
    with pytest.raises(ValueError):
        store.exists("garbage/foo.png")
    with pytest.raises(ValueError):
        store.exists("foo.png")
    with pytest.raises(ValueError):
        store.exists("")
    with pytest.raises(ValueError):
        store.exists("outputs/../etc")


# ── list_prefix ──────────────────────────────────────────────────

def test_list_prefix_returns_matching_keys_sorted(s3_setup):
    client, store = s3_setup
    for name in ("zeta.png", "alpha.png", "mid.png"):
        client.put_object(Bucket=BUCKET, Key=f"{ROOT}/uploads/{name}", Body=b"x")
    entries = store.list_prefix("uploads/")
    keys = [e["Key"] for e in entries]
    assert keys == ["uploads/alpha.png", "uploads/mid.png", "uploads/zeta.png"]


def test_list_prefix_only_returns_keys_under_env_project(s3_setup):
    """If the bucket has objects under a different env+project prefix,
    they must NOT leak into our results."""
    client, store = s3_setup
    client.put_object(Bucket=BUCKET, Key=f"{ROOT}/uploads/mine.png", Body=b"x")
    client.put_object(Bucket=BUCKET, Key="prod/other-app/uploads/theirs.png", Body=b"y")
    keys = [e["Key"] for e in store.list_prefix("uploads/")]
    assert keys == ["uploads/mine.png"]


def test_list_prefix_subprefix(s3_setup):
    client, store = s3_setup
    client.put_object(Bucket=BUCKET, Key=f"{ROOT}/outputs/hosts/saved/h1.png", Body=b"x")
    client.put_object(Bucket=BUCKET, Key=f"{ROOT}/outputs/result.mp4", Body=b"y")
    keys = [e["Key"] for e in store.list_prefix("outputs/hosts/")]
    assert keys == ["outputs/hosts/saved/h1.png"]


def test_list_prefix_empty_for_invalid_inputs(s3_setup):
    _, store = s3_setup
    assert store.list_prefix("garbage/") == []
    assert store.list_prefix("") == []
    assert store.list_prefix("outputs") == []  # no slash


def test_list_prefix_lastmodified_is_datetime(s3_setup):
    client, store = s3_setup
    client.put_object(Bucket=BUCKET, Key=f"{ROOT}/uploads/a.png", Body=b"x")
    entries = store.list_prefix("uploads/")
    assert isinstance(entries[0]["LastModified"], datetime)
    assert entries[0]["LastModified"].tzinfo is not None


# ── url_for / presigned ──────────────────────────────────────────

def test_url_for_returns_presigned_url(s3_setup):
    client, store = s3_setup
    client.put_object(Bucket=BUCKET, Key=f"{ROOT}/outputs/v.mp4", Body=b"x")
    url = store.url_for("outputs/v.mp4", expires_in=3600)
    parsed = urlparse(url)
    assert BUCKET in url
    assert f"{ROOT}/outputs/v.mp4" in unquote(parsed.path + "?" + parsed.query)
    qs = parse_qs(parsed.query)
    # Accept both SigV2 (`Signature` + `Expires`) and SigV4
    # (`X-Amz-Signature` + `X-Amz-Expires`) — moto uses the former by
    # default, real AWS the latter. Either way the URL must be signed.
    sig_keys = [k for k in qs if "signature" in k.lower()]
    expires_keys = [k for k in qs if "expires" in k.lower()]
    assert sig_keys, f"expected signature param in {list(qs.keys())}"
    assert expires_keys, f"expected expires param in {list(qs.keys())}"


def test_url_for_with_download_filename_signs_content_disposition(s3_setup):
    client, store = s3_setup
    client.put_object(Bucket=BUCKET, Key=f"{ROOT}/outputs/v.mp4", Body=b"x")
    url = store.url_for(
        "outputs/v.mp4",
        expires_in=3600,
        download_filename="my video.mp4",
    )
    qs = parse_qs(urlparse(url).query)
    # ResponseContentDisposition is signed into the URL — browsers will
    # see attachment; filename="my video.mp4" on response.
    cd_keys = [k for k in qs if "response-content-disposition" in k.lower()]
    assert cd_keys, f"expected ResponseContentDisposition in {list(qs.keys())}"
    cd_value = unquote(qs[cd_keys[0]][0])
    assert "attachment" in cd_value
    assert 'filename="my video.mp4"' in cd_value


def test_url_for_validates_key(s3_setup):
    _, store = s3_setup
    with pytest.raises(ValueError):
        store.url_for("foo.png")
    with pytest.raises(ValueError):
        store.url_for("outputs/../etc")


# ── delete ────────────────────────────────────────────────────────

def test_delete_existing_returns_true(s3_setup):
    client, store = s3_setup
    client.put_object(Bucket=BUCKET, Key=f"{ROOT}/outputs/del.mp4", Body=b"x")
    assert store.delete("outputs/del.mp4") is True
    # Second time: object already gone.
    assert store.delete("outputs/del.mp4") is False


def test_delete_missing_returns_false(s3_setup):
    _, store = s3_setup
    assert store.delete("outputs/never-existed.mp4") is False


# ── C3 review fixes ──────────────────────────────────────────────

def test_save_bytes_empty_data(s3_setup):
    """0-byte put_object must round-trip cleanly."""
    client, store = s3_setup
    key = store.save_bytes("uploads", b"", basename="empty.bin")
    assert key == "uploads/empty.bin"
    obj = client.get_object(Bucket=BUCKET, Key=f"{ROOT}/uploads/empty.bin")
    assert obj["Body"].read() == b""
    assert obj["ContentLength"] == 0


def test_url_for_download_filename_strips_unsafe_chars(s3_setup):
    """Quote / CR / LF / backslash must be stripped before signing —
    they would break the Content-Disposition header round-trip."""
    client, store = s3_setup
    client.put_object(Bucket=BUCKET, Key=f"{ROOT}/outputs/v.mp4", Body=b"x")
    url = store.url_for(
        "outputs/v.mp4",
        download_filename='evil"file\r\nInjection: header\\extra.mp4',
    )
    qs = parse_qs(urlparse(url).query)
    cd_keys = [k for k in qs if "response-content-disposition" in k.lower()]
    cd_value = unquote(qs[cd_keys[0]][0])
    # Sanitized value: quotes, CR, LF, backslash all gone.
    assert '"' not in cd_value.replace('filename="', "").rstrip('"')
    assert "\r" not in cd_value
    assert "\n" not in cd_value
    assert "\\" not in cd_value


def test_url_for_download_filename_preserves_unicode(s3_setup):
    """Korean / emoji filenames must round-trip — sanitizer only strips
    structural characters, not Unicode codepoints."""
    client, store = s3_setup
    client.put_object(Bucket=BUCKET, Key=f"{ROOT}/outputs/v.mp4", Body=b"x")
    url = store.url_for(
        "outputs/v.mp4",
        download_filename="내 영상.mp4",
    )
    qs = parse_qs(urlparse(url).query)
    cd_keys = [k for k in qs if "response-content-disposition" in k.lower()]
    cd_value = unquote(qs[cd_keys[0]][0])
    assert "내 영상.mp4" in cd_value


def test_list_prefix_rejects_traversal(s3_setup):
    """`..` segments inside a valid bucket prefix must raise — defense
    against attacker-controlled prefix crossing the env+project root.

    `..` as the bucket itself is just an unknown bucket → empty list
    (consistent with how list_prefix handles other unknown buckets, no
    need for a special-cased raise that contradicts that rule)."""
    _, store = s3_setup
    with pytest.raises(ValueError, match="invalid prefix"):
        store.list_prefix("uploads/../outputs/")
    with pytest.raises(ValueError, match="invalid prefix"):
        store.list_prefix("uploads/sub/../etc/")
    # `..` as the first segment is just an unknown bucket.
    assert store.list_prefix("../outside/") == []


def test_make_default_s3_store_raises_on_empty_credentials(monkeypatch):
    """Empty S3_ACCESS_KEY/SECRET_KEY must fail-fast — boto3 default
    credential chain fallback is the silent failure mode plan §1 #2
    rejects."""
    import config as config_module
    from modules import storage_s3

    monkeypatch.setattr(config_module, "S3_ACCESS_KEY", "")
    monkeypatch.setattr(config_module, "S3_SECRET_KEY", "secret")
    with pytest.raises(ValueError, match="S3_ACCESS_KEY and S3_SECRET_KEY"):
        storage_s3.make_default_s3_store()

    monkeypatch.setattr(config_module, "S3_ACCESS_KEY", "key")
    monkeypatch.setattr(config_module, "S3_SECRET_KEY", "")
    with pytest.raises(ValueError, match="S3_ACCESS_KEY and S3_SECRET_KEY"):
        storage_s3.make_default_s3_store()


def test_make_default_s3_store_succeeds_with_credentials(monkeypatch):
    import config as config_module
    from modules import storage_s3

    monkeypatch.setattr(config_module, "S3_ACCESS_KEY", "AKIA...")
    monkeypatch.setattr(config_module, "S3_SECRET_KEY", "...")
    monkeypatch.setattr(config_module, "S3_BUCKET", "ailab-demo")
    monkeypatch.setattr(config_module, "S3_ENV_PREFIX", "dev")
    monkeypatch.setattr(config_module, "S3_PROJECT_NAME", "soulx-flashtalk")
    store = storage_s3.make_default_s3_store()
    assert store._bucket == "ailab-demo"
    assert store._root == "dev/soulx-flashtalk"
    assert store._client is None  # still lazy
