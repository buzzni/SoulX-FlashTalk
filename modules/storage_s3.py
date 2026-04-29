"""S3-backed MediaStore (PR S3+).

`S3MediaStore` is the cutover target for `media_store` — a drop-in for
`LocalDiskMediaStore` that maps every storage_key (`outputs/...`,
`uploads/...`, `examples/...`) to an S3 object under
``<S3_ENV_PREFIX>/<S3_PROJECT_NAME>/<storage_key>``.

Design notes
============

- **Lazy boto3 client.** `__init__` does not call AWS. The client is
  built on first use so (a) tests can inject a moto-mock client at
  construction, (b) boot doesn't fail when credentials are missing or
  the network is down, and (c) CI without AWS access still imports
  cleanly.

- **Atomic writes.** boto3's `upload_file` / `download_file` already use
  multipart + temp files internally — no extra wrapping needed. Failures
  raise `ClientError`; partial-state isn't visible to readers.

- **`open_local()` cleanup.** Downloads to `tempfile.mkstemp` and
  unlinks in the `finally`. Callers passing the path to a subprocess
  MUST keep the ctx open until that subprocess has finished
  (`proc.wait()` before the `with` block exits) — see the docstring on
  `LocalDiskMediaStore.open_local()` for the same contract.

- **`local_path_for()` / `key_from_path()` raise `NotImplementedError`.**
  S3 has no canonical local path. Callers should be migrated to
  `open_local()` / `download_to()` / direct key construction before the
  cutover commit (C13). The deprecation warnings emitted by the legacy
  methods on `LocalDiskMediaStore` should already have flushed every
  call site out.

- **`url_for()`.** Generates a presigned GET URL with TTL; `download_filename`
  is signed via `ResponseContentDisposition` so the browser sees an
  `attachment; filename="…"` header and treats `<a download>` correctly.

- **`head()` / `list_prefix()` types.** Match `LocalDiskMediaStore`
  exactly — `LastModified` is tz-aware datetime (boto3 returns one),
  `ETag` is the quoted MD5 hex S3 supplies (LocalDisk returns a weak
  ETag of the same shape `W/"size-mtime"`; callers compare via
  `If-None-Match` semantics, not byte equality).
"""
from __future__ import annotations

import os
import secrets
import tempfile
from contextlib import contextmanager
from datetime import timezone
from pathlib import Path
from typing import Any, Iterator, Optional

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config
from botocore.exceptions import ClientError

import config
from modules.storage import (
    build_storage_key,
    route_kind,
    validate_key,
)


# Map file extension → Content-Type (used for upload + put_object).
_CONTENT_TYPES: dict[str, str] = {
    "mp4":  "video/mp4",
    "m3u8": "application/x-mpegURL",
    "ts":   "video/MP2T",
    "png":  "image/png",
    "jpg":  "image/jpeg",
    "jpeg": "image/jpeg",
    "gif":  "image/gif",
    "webp": "image/webp",
    "mp3":  "audio/mpeg",
    "wav":  "audio/wav",
    "flac": "audio/flac",
    "json": "application/json",
    "txt":  "text/plain",
}


def _guess_content_type(filename: str) -> Optional[str]:
    """Best-effort Content-Type from the filename's extension.

    NOT a security check — magic-byte validation lives upstream in
    `validate_image_upload()` / `validate_audio_upload()` (`app.py`).
    A user can still rename `evil.exe` to `evil.png` and this function
    will return `image/png`. The store trusts the caller to have
    validated the actual bytes before handing the file off.
    """
    ext = Path(filename).suffix.lstrip(".").lower()
    return _CONTENT_TYPES.get(ext)


def _sanitize_download_filename(filename: str) -> str:
    """Strip characters that would break the `Content-Disposition`
    header round-trip.

    Browsers ultimately receive `filename="<value>"`. The value is
    inside double quotes, so we strip any character that breaks framing,
    enables header injection, or upsets path quoting on the receiving
    OS:

        - `"`         (closes the filename="..." framing prematurely)
        - CR / LF     (HTTP header injection)
        - `\\`        (Windows path quoting; backslash escape collisions)

    We do NOT do RFC 6266 / RFC 5987 (`filename*=UTF-8''…`) double-
    encoding here — boto3 will URL-encode the whole header value when
    signing, and modern browsers handle UTF-8 inside `filename="..."`.
    Korean filenames work; pathological filenames (`a"b\\rcr.mp4`) are
    sanitized rather than rejected so callers don't have to think
    about it.
    """
    return "".join(c for c in filename if c not in '"\r\n\\')


# Error codes S3 returns when an object/key is missing. 403
# (AccessDenied) and 5xx are intentionally NOT in this list — they
# propagate to the caller so a bucket-policy regression or an outage
# is loud, not silent (review-findings #15c).
_NOT_FOUND_CODES = ("404", "NoSuchKey", "NotFound")


class S3MediaStore:
    """S3 backend implementing the `MediaStore` Protocol."""

    def __init__(
        self,
        *,
        bucket: str,
        env_prefix: str,
        project: str,
        region: Optional[str] = None,
        access_key: Optional[str] = None,
        secret_key: Optional[str] = None,
        client: Optional[Any] = None,
    ):
        if not bucket:
            raise ValueError("S3MediaStore requires a non-empty bucket")
        if not env_prefix:
            raise ValueError("S3MediaStore requires a non-empty env_prefix")
        if not project:
            raise ValueError("S3MediaStore requires a non-empty project")
        self._bucket = bucket
        self._root = f"{env_prefix}/{project}"
        self._region = region
        self._access_key = access_key
        self._secret_key = secret_key
        # Tests inject a moto-backed client here to skip real AWS.
        self._client = client

    # ── client (lazy) ───────────────────────────────────────────────
    @property
    def s3(self):
        if self._client is None:
            self._client = boto3.client(
                "s3",
                region_name=self._region,
                aws_access_key_id=self._access_key or None,
                aws_secret_access_key=self._secret_key or None,
                config=Config(
                    # Force SigV4 — required for ap-northeast-2 and every
                    # region newer than us-east-1 anyway. moto's default
                    # SigV2 in tests doesn't represent production.
                    signature_version="s3v4",
                    retries={
                        "max_attempts": config.S3_MAX_RETRY_ATTEMPTS,
                        "mode": "standard",
                    },
                    max_pool_connections=config.S3_MAX_POOL_CONNECTIONS,
                    connect_timeout=config.S3_CONNECT_TIMEOUT,
                    read_timeout=config.S3_READ_TIMEOUT,
                ),
            )
        return self._client

    # ── internal ────────────────────────────────────────────────────
    def _full_key(self, key: str) -> str:
        validate_key(key)
        return f"{self._root}/{key}"

    def _full_prefix(self, prefix: str) -> str:
        # list_prefix accepts shorter forms than validate_key wants
        # (e.g. "outputs/hosts/"), so we don't go through validate_key.
        # We still refuse '..' segments — S3 doesn't normalize them and
        # an attacker-controlled prefix could otherwise cross out of
        # the env+project root.
        for seg in prefix.split("/"):
            if seg == "..":
                raise ValueError(f"invalid prefix segment: {prefix!r}")
        return f"{self._root}/{prefix}"

    def _normalize_dt(self, dt):
        if dt is None:
            return None
        # boto3 returns tz-aware datetimes; defensive-only fallback.
        return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)

    def _is_not_found(self, exc: ClientError) -> bool:
        code = exc.response.get("Error", {}).get("Code")
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        return code in _NOT_FOUND_CODES or status == 404

    # ── PR3 (kind-based, kept for parity with LocalDisk) ────────────
    def save_bytes(self, kind: str, data: bytes, *,
                    suffix: str = "", basename: Optional[str] = None) -> str:
        bucket, sub = route_kind(kind)
        if basename is None:
            basename = secrets.token_hex(8) + suffix
        key = build_storage_key(bucket, sub, basename)
        extra = {"Body": data, "Bucket": self._bucket, "Key": self._full_key(key)}
        ct = _guess_content_type(basename)
        if ct:
            extra["ContentType"] = ct
        self.s3.put_object(**extra)
        return key

    def save_path(self, kind: str, src: Path, *,
                   basename: Optional[str] = None) -> str:
        src = Path(src)
        bucket, sub = route_kind(kind)
        if basename is None:
            basename = src.name
        key = build_storage_key(bucket, sub, basename)
        self.upload(src, key)
        return key

    # ── deprecated / not applicable on S3 ───────────────────────────
    def local_path_for(self, key: str) -> Path:
        raise NotImplementedError(
            "S3MediaStore has no local path; use open_local() or "
            "download_to() instead."
        )

    def key_from_path(self, abs_path) -> str:
        raise NotImplementedError(
            "S3MediaStore has no local path; build the storage_key "
            "directly in the generator."
        )

    # ── PR S3+ key-based API ────────────────────────────────────────
    def upload(self, src: Path, key: str) -> None:
        """Upload `src` to S3 at `key`.

        boto3 `upload_file` handles multipart split + retry + abort
        internally — partial state isn't visible to readers and a
        failed multipart cleans up its own parts. The one gap is
        SIGKILL: the process can't run abort code, so multiparts
        leak silently. Bucket lifecycle rule
        `AbortIncompleteMultipartUpload: 1d` (plan §8.2) sweeps them
        within a day.

        Caller cancellation: not supported. Once `upload_file`
        starts, there's no thread-safe stop. Tasks needing cancel
        must rely on process-level kill + lifecycle cleanup.

        Retry: this method does NOT add an outer retry — boto3
        Config gives `S3_MAX_RETRY_ATTEMPTS` total attempts
        (default 3). Plan §1 #6 requires the caller (generate_video_task)
        to wrap the whole upload in a small outer loop so a 5-minute
        GPU job isn't lost to one transient ClientError after the
        boto3 retries are exhausted.
        """
        src = Path(src)
        full = self._full_key(key)
        extra: dict[str, Any] = {}
        ct = _guess_content_type(src.name)
        if ct:
            extra["ContentType"] = ct
        transfer = TransferConfig(
            multipart_threshold=config.S3_MULTIPART_THRESHOLD,
        )
        self.s3.upload_file(
            str(src),
            self._bucket,
            full,
            ExtraArgs=extra or None,
            Config=transfer,
        )

    def download_to(self, key: str, dst: Path) -> None:
        dst = Path(dst)
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.s3.download_file(
                self._bucket,
                self._full_key(key),
                str(dst),
            )
        except ClientError as exc:
            if self._is_not_found(exc):
                raise FileNotFoundError(key) from exc
            raise

    @contextmanager
    def open_local(self, key: str) -> Iterator[Path]:
        """Download `key` to a temp file and yield its path. Unlinks the
        temp file on context exit — callers passing the path to a
        subprocess MUST keep the context open until that subprocess has
        finished (see `LocalDiskMediaStore.open_local` docstring)."""
        # Pre-validate key so a bad key fails before we create the temp.
        self._full_key(key)
        suffix = Path(key).suffix
        fd, tmp_str = tempfile.mkstemp(prefix="s3-open-", suffix=suffix)
        os.close(fd)
        tmp = Path(tmp_str)
        try:
            try:
                self.s3.download_file(self._bucket, self._full_key(key), str(tmp))
            except ClientError as exc:
                if self._is_not_found(exc):
                    raise FileNotFoundError(key) from exc
                raise
            yield tmp
        finally:
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass

    def url_for(self, key: str, *, expires_in: int = 3600,
                download_filename: Optional[str] = None) -> str:
        params: dict[str, Any] = {
            "Bucket": self._bucket,
            "Key": self._full_key(key),
        }
        if download_filename:
            # Strip header-injection / framing-breaking characters
            # before stuffing into Content-Disposition.
            safe = _sanitize_download_filename(download_filename)
            params["ResponseContentDisposition"] = (
                f'attachment; filename="{safe}"'
            )
        return self.s3.generate_presigned_url(
            "get_object",
            Params=params,
            ExpiresIn=expires_in,
        )

    def delete(self, key: str) -> bool:
        """Delete the object at `key`. Returns True iff the object was
        present at the time of the head_object check.

        Race note: there's a TOCTOU between `head_object` and
        `delete_object`. If another process deletes the object in
        between, we still return True (head said it existed). The
        return value's contract is "head saw it", not "this call
        removed it". Callers needing exact-once semantics must use
        S3 versioning + conditional deletes — out of scope for the
        current PoC.
        """
        full = self._full_key(key)
        try:
            self.s3.head_object(Bucket=self._bucket, Key=full)
        except ClientError as exc:
            if self._is_not_found(exc):
                return False
            raise
        self.s3.delete_object(Bucket=self._bucket, Key=full)
        return True

    def head(self, key: str) -> dict:
        """Return ContentLength / LastModified / ETag for `key`.

        ETag contract (matches LocalDisk): treat the value as opaque.
        S3 returns a quoted MD5 hex (`"abc123…"`); LocalDisk returns
        a weak ETag (`W/"size-mtime"`). The two are NOT byte-for-byte
        equal across backends — callers must compare using
        `If-None-Match` / `If-Range` semantics, not `==`.
        """
        try:
            resp = self.s3.head_object(Bucket=self._bucket, Key=self._full_key(key))
        except ClientError as exc:
            if self._is_not_found(exc):
                raise FileNotFoundError(key) from exc
            raise
        return {
            "ContentLength": int(resp.get("ContentLength", 0)),
            "LastModified": self._normalize_dt(resp.get("LastModified")),
            "ETag": resp.get("ETag"),
        }

    def exists(self, key: str) -> bool:
        # Validate up-front — invalid keys raise ValueError (parity with
        # LocalDiskMediaStore.exists).
        full = self._full_key(key)
        try:
            self.s3.head_object(Bucket=self._bucket, Key=full)
            return True
        except ClientError as exc:
            if self._is_not_found(exc):
                return False
            raise

    def list_prefix(self, prefix: str) -> list[dict]:
        """List all keys starting with `prefix`. Returns S3-shaped
        entries sorted by `Key` (parity with LocalDisk).

        Empty / slash-less prefix → empty list (we choose stricter
        semantics than S3's `Prefix=""` so callers can't accidentally
        walk the entire bucket). Unknown bucket → empty list.
        """
        if not prefix or "/" not in prefix:
            return []
        bucket_name, _, _ = prefix.partition("/")
        # Late import to avoid cycles; uses the same bucket whitelist
        # LocalDisk uses so backends behave identically on bad prefixes.
        from modules.storage import _bucket_dirs
        if bucket_name not in _bucket_dirs():
            return []
        full_prefix = self._full_prefix(prefix)
        paginator = self.s3.get_paginator("list_objects_v2")
        results: list[dict] = []
        root_with_slash = self._root + "/"
        for page in paginator.paginate(Bucket=self._bucket, Prefix=full_prefix):
            for obj in page.get("Contents", []):
                full_key = obj["Key"]
                if not full_key.startswith(root_with_slash):
                    continue
                short_key = full_key[len(root_with_slash):]
                results.append({
                    "Key": short_key,
                    "Size": int(obj.get("Size", 0)),
                    "LastModified": self._normalize_dt(obj.get("LastModified")),
                })
        # boto3 already returns sorted by Key but enforce contract.
        results.sort(key=lambda e: e["Key"])
        return results


def make_default_s3_store() -> S3MediaStore:
    """Build an `S3MediaStore` from `config.S3_*` settings. Used by the
    cutover commit (C13) to swap `modules.storage.media_store`.

    Fail-fast on empty credentials. boto3 silently falls back to its
    default credential chain (env vars / `~/.aws/credentials` / IAM
    role) when access_key/secret_key are empty — that means a missing
    `.env` value would silently leak through to a developer's local
    AWS profile, or attach the EC2 instance role in production. plan
    §1 #2 picks fail-fast everywhere instead of that ambiguity.
    """
    if not config.S3_ACCESS_KEY or not config.S3_SECRET_KEY:
        raise ValueError(
            "S3MediaStore: S3_ACCESS_KEY and S3_SECRET_KEY must be set in "
            ".env. Empty credentials would silently fall back to the boto3 "
            "default credential chain (env vars / ~/.aws/credentials / IAM "
            "role); fail-fast is the agreed policy (plan §1 #2)."
        )
    return S3MediaStore(
        bucket=config.S3_BUCKET,
        env_prefix=config.S3_ENV_PREFIX,
        project=config.S3_PROJECT_NAME,
        region=config.S3_REGION,
        access_key=config.S3_ACCESS_KEY,
        secret_key=config.S3_SECRET_KEY,
    )
