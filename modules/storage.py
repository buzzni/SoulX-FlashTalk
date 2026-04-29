"""Media storage abstraction (PR3 + PR S3+).

The DB never stores absolute filesystem paths. It stores `storage_key` —
a bucket-prefixed relative key like `outputs/hosts/saved/host_x_s42.png`
or `uploads/ref_img_abc.png`. `LocalDiskMediaStore` resolves keys against
config-driven bucket directories; `S3MediaStore` (PR S3+) maps the same
keys to S3 objects under <S3_ENV_PREFIX>/<S3_PROJECT_NAME>/<key>.

Key shape (decision #16):
    <bucket>/<rest>
where bucket ∈ {"outputs", "uploads", "examples"} and `rest` is the
relative path inside that bucket. The `kind` argument on save_*() is used
ONLY to route to the right bucket + subpath; it never appears in the key.

Buckets:
    outputs/   — generated artifacts (hosts, composites, videos, tts)
    uploads/   — user-supplied content (refs, backgrounds, raw uploads)
    examples/  — read-only seed assets

`local_path_for()` partitions on the first '/' and joins the *remainder*
with the bucket dir — joining the full key would double-apply the bucket
(codex #N2). All key resolution rejects '..' segments and unknown buckets.

v2 (S3 migration) additions to the Protocol:
    - upload(src, key)        — atomic write (tempfile + os.replace)
    - download_to(key, dst)   — atomic write at dst
    - open_local(key)         — ctx manager: S3 downloads to a temp file
                                and unlinks on exit; LocalDisk yields
                                the live path (no cleanup). Callers must
                                keep the ctx open until any subprocess
                                that uses the path has finished.
    - head/exists/list_prefix — metadata + listing (S3 head_object/list).
                                head() returns a weak ETag and a
                                tz-aware datetime so LocalDisk and S3
                                are byte-compatible for callers.
    - url_for(key, *, expires_in, download_filename)
                              — presigned URL on S3; LocalDisk encodes
                                download_filename as a query param so
                                /api/files/ can decorate Content-Disposition.

`local_path_for()` and `key_from_path()` are kept for legacy callers but
emit DeprecationWarning. New code should use `open_local()` / `upload()` /
`download_to()` instead. See `specs/s3-migration/plan.md` §3.1 for the
full call-site migration matrix.
"""
from __future__ import annotations

import os
import secrets
import shutil
import tempfile
import warnings
from contextlib import AbstractContextManager, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator, Optional, Protocol
from urllib.parse import quote

import config


# Map kind → (bucket, optional sub-path inside the bucket).
# Multiple kinds can share a bucket; the sub-path keeps similar artifacts
# grouped under the same dir layout the current code already uses.
_KIND_PATH: dict[str, tuple[str, str]] = {
    # outputs/* (generated)
    "hosts":        ("outputs", "hosts/saved"),
    "composites":   ("outputs", "composites"),
    "videos":       ("outputs", ""),
    "tts":          ("outputs", ""),
    # uploads/* (user-supplied)
    "uploads":      ("uploads", ""),
    "ref_images":   ("uploads", ""),
    "backgrounds":  ("uploads", ""),
    # examples/* (seed)
    "examples":     ("examples", ""),
}


def _bucket_dirs() -> dict[str, str]:
    """Built lazily from config so tests can monkeypatch config.*_DIR."""
    return {
        "outputs":  config.OUTPUTS_DIR,
        "uploads":  config.UPLOADS_DIR,
        "examples": config.EXAMPLES_DIR,
    }


# Module-level helpers shared by every backend.

def validate_key(key: str) -> tuple[str, str]:
    """Validate a bucket-prefixed storage_key and return (bucket, rest).

    Raises ValueError on:
    - empty key, or key without bucket prefix
    - unknown bucket
    - any segment equal to '..' (prevent traversal)

    Both LocalDisk and S3 backends call this so they reject the same
    set of keys — keeps backend swap behaviour-equivalent.
    """
    if not key or "/" not in key:
        raise ValueError(f"key must be bucket-prefixed: got {key!r}")
    bucket, _, rest = key.partition("/")
    if bucket not in _bucket_dirs():
        raise ValueError(f"unknown bucket: {bucket!r}")
    if not rest:
        raise ValueError(f"empty key inside bucket: {key!r}")
    for seg in rest.split("/"):
        if seg in ("..", "") or seg.strip() == "":
            raise ValueError(f"invalid key segment: {key!r}")
    return bucket, rest


def route_kind(kind: str) -> tuple[str, str]:
    """Resolve `kind` to its (bucket, sub-path). Raises ValueError for
    unknown kinds. Used by both backends to build storage keys."""
    if kind not in _KIND_PATH:
        raise ValueError(f"unknown media kind: {kind!r}")
    return _KIND_PATH[kind]


def build_storage_key(bucket: str, sub: str, basename: str) -> str:
    """Compose a storage_key from (bucket, sub, basename) — same shape
    both backends produce."""
    return "/".join(p for p in (bucket, sub, basename) if p)


class MediaStore(Protocol):
    # PR3 (kind-based, legacy)
    def save_bytes(self, kind: str, data: bytes, *,
                    suffix: str = "", basename: Optional[str] = None) -> str: ...
    def save_path(self, kind: str, src: Path, *,
                   basename: Optional[str] = None) -> str: ...
    def local_path_for(self, key: str) -> Path: ...                       # deprecated
    def key_from_path(self, abs_path) -> str: ...                          # deprecated
    def url_for(self, key: str, *, expires_in: int = 3600,
                download_filename: Optional[str] = None) -> str: ...
    def delete(self, key: str) -> bool: ...

    # PR S3+ (key-based, S3-fit)
    def upload(self, src: Path, key: str) -> None: ...
    def download_to(self, key: str, dst: Path) -> None: ...
    def open_local(self, key: str) -> AbstractContextManager[Path]: ...
    def head(self, key: str) -> dict: ...
    def exists(self, key: str) -> bool: ...
    def list_prefix(self, prefix: str) -> list[dict]: ...


class LocalDiskMediaStore:
    """Default backend: writes go straight to local disk under config dirs.

    Stays a drop-in for `S3MediaStore` during the migration: every method
    in the Protocol is implemented so callers don't branch on backend.
    """

    # ── internal helpers ────────────────────────────────────────────
    def _route(self, kind: str) -> tuple[str, str, Path]:
        bucket, sub = route_kind(kind)
        target = Path(_bucket_dirs()[bucket])
        if sub:
            target = target / sub
        return bucket, sub, target

    def _build_key(self, bucket: str, sub: str, basename: str) -> str:
        return build_storage_key(bucket, sub, basename)

    def _validate_and_resolve(self, key: str) -> Path:
        """Validate `key` and return its absolute path. No deprecation
        warning — used by every internal method so they don't shout at
        themselves."""
        bucket, rest = validate_key(key)
        return Path(_bucket_dirs()[bucket]) / rest

    def _atomic_copy(self, src: Path, dst: Path) -> None:
        """tempfile in dst.parent + os.replace — partial writes never
        appear at `dst`. Caller must have ensured dst.parent exists."""
        fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=str(dst.parent))
        os.close(fd)
        try:
            shutil.copyfile(src, tmp)
            os.replace(tmp, dst)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    # ── PR3 (kind-based, legacy) ────────────────────────────────────
    def save_bytes(self, kind: str, data: bytes, *,
                    suffix: str = "", basename: Optional[str] = None) -> str:
        bucket, sub, target = self._route(kind)
        if basename is None:
            basename = secrets.token_hex(8) + suffix
        target.mkdir(parents=True, exist_ok=True)
        (target / basename).write_bytes(data)
        return self._build_key(bucket, sub, basename)

    def save_path(self, kind: str, src: Path, *,
                   basename: Optional[str] = None) -> str:
        """Copy `src` into the appropriate bucket and return its storage_key.

        Uses copy (not move) — callers may want the source kept around.
        """
        src = Path(src)
        bucket, sub, target = self._route(kind)
        if basename is None:
            basename = src.name
        target.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, target / basename)
        return self._build_key(bucket, sub, basename)

    def local_path_for(self, key: str) -> Path:
        """[DEPRECATED] Resolve a storage_key to its absolute on-disk path.

        Cutover plan: callers should switch to `open_local()` /
        `download_to()` (which work for both LocalDisk and S3). See
        `specs/s3-migration/plan.md` §3.1 for the call-site matrix.
        """
        warnings.warn(
            "local_path_for() is deprecated; use open_local() or "
            "download_to() for S3-backend portability. See "
            "specs/s3-migration/plan.md §3.1.",
            DeprecationWarning,
            stacklevel=2,
        )
        return self._validate_and_resolve(key)

    def key_from_path(self, abs_path) -> str:
        """[DEPRECATED] Convert an absolute filesystem path to a
        bucket-prefixed storage_key.

        Cutover plan: generators should build the storage_key directly
        rather than writing to disk and reverse-mapping. See
        `specs/s3-migration/plan.md` §3.1.
        """
        warnings.warn(
            "key_from_path() is deprecated; build the storage_key "
            "directly in the generator instead of reverse-mapping. See "
            "specs/s3-migration/plan.md §3.1.",
            DeprecationWarning,
            stacklevel=2,
        )
        target = Path(abs_path).resolve()
        for bucket, root in _bucket_dirs().items():
            try:
                bucket_root = Path(root).resolve()
            except FileNotFoundError:
                continue
            try:
                rel = target.relative_to(bucket_root)
            except ValueError:
                continue
            if str(rel) in (".", ""):
                continue
            return f"{bucket}/{rel}"
        raise ValueError(f"path {abs_path!r} is not inside any known bucket")

    def url_for(self, key: str, *, expires_in: int = 3600,
                download_filename: Optional[str] = None) -> str:
        """Return a URL the browser can fetch for `key`.

        LocalDisk: returns `/api/files/{key}` and (if `download_filename`
        is set) appends `?download_filename=<urlencoded>` so the
        `/api/files` handler can set Content-Disposition. S3 backend will
        sign a presigned GET with `expires_in` and (optionally) the same
        download filename via `ResponseContentDisposition`.
        """
        self._validate_and_resolve(key)
        url = f"/api/files/{key}"
        if download_filename:
            url = f"{url}?download_filename={quote(download_filename, safe='')}"
        return url

    def delete(self, key: str) -> bool:
        """Delete the file backing `key`. Returns True if a file was removed."""
        path = self._validate_and_resolve(key)
        try:
            path.unlink()
            return True
        except FileNotFoundError:
            return False

    # ── PR S3+ (key-based, S3-fit) ──────────────────────────────────
    def upload(self, src: Path, key: str) -> None:
        """Atomically write `src` to the bucket location for `key`.

        S3 parity: writes the file to storage at `key`. Caller still owns
        `src` and is responsible for cleanup. If `src` and `dst` resolve
        to the same path the call is a silent no-op (avoids
        `shutil.SameFileError` when a wrapper accidentally re-uploads
        a file that's already in place).
        """
        src = Path(src)
        dst = self._validate_and_resolve(key)
        dst.parent.mkdir(parents=True, exist_ok=True)
        # Same-file no-op: caller passed src == dst location.
        try:
            if src.resolve(strict=True) == dst.resolve():
                return
        except FileNotFoundError:
            # src missing → let copyfile raise the canonical error below.
            pass
        self._atomic_copy(src, dst)

    def download_to(self, key: str, dst: Path) -> None:
        """Atomically copy the file at `key` into `dst`."""
        src = self._validate_and_resolve(key)
        if not src.exists():
            raise FileNotFoundError(key)
        dst = Path(dst)
        dst.parent.mkdir(parents=True, exist_ok=True)
        self._atomic_copy(src, dst)

    @contextmanager
    def open_local(self, key: str) -> Iterator[Path]:
        """Yield a local Path for `key`.

        LocalDisk: yields the resolved live path; nothing is unlinked on
        exit. S3 backend: downloads `key` to a temp file, yields that
        path, and unlinks it on context exit.

        IMPORTANT contract for callers
        ──────────────────────────────
        The yielded path may be unlinked the moment the context exits
        (S3 backend). If you pass it to a subprocess (torchrun, ffmpeg,
        librosa.load on disk) you MUST keep the context open until that
        subprocess has fully finished reading the file (`proc.wait()`
        before the `with` block ends).

        On LocalDisk this invariant is silently satisfied because the
        path is the canonical bucket location, never deleted by the
        ctx manager. Tests that pass on LocalDisk therefore CANNOT
        prove the invariant — the corresponding S3 race test lives in
        `tests/test_storage_s3.py` (next commit).
        """
        path = self._validate_and_resolve(key)
        if not path.exists():
            raise FileNotFoundError(key)
        yield path

    def head(self, key: str) -> dict:
        """Return a subset of `head_object` fields callers actually use.

        Backend parity:
          - ContentLength: int (bytes)
          - LastModified: tz-aware datetime (UTC)
          - ETag: weak ETag of the form `W/"<size>-<mtime_int>"` on
                  LocalDisk; quoted MD5 hex on S3. Callers comparing
                  ETags must accept either format (use `If-None-Match`
                  semantics, not byte-for-byte equality).
        """
        path = self._validate_and_resolve(key)
        if not path.exists():
            raise FileNotFoundError(key)
        st = path.stat()
        return {
            "ContentLength": st.st_size,
            "LastModified": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc),
            "ETag": f'W/"{st.st_size}-{int(st.st_mtime)}"',
        }

    def exists(self, key: str) -> bool:
        """Return True iff `key` resolves to a file that exists.

        Invalid keys (unknown bucket, traversal, missing slash, empty)
        raise ValueError — callers must validate keys upstream rather
        than relying on a silent False.
        """
        return self._validate_and_resolve(key).exists()

    def list_prefix(self, prefix: str) -> list[dict]:
        """List keys starting with `prefix` (bucket-prefixed, e.g.
        'uploads/' or 'outputs/hosts/').

        Returns S3-shaped entries sorted by `Key`:
            [{"Key": str, "Size": int, "LastModified": datetime}].

        - Empty/slash-less prefix → empty list (S3 treats `Prefix=""`
          as the entire bucket; we choose stricter semantics so
          callers can't accidentally walk everything).
        - Unknown bucket → empty list (parity with S3).
        - Symlinks are not followed (defense against escape).
        """
        if not prefix or "/" not in prefix:
            return []
        bucket, _, _ = prefix.partition("/")
        dirs = _bucket_dirs()
        if bucket not in dirs:
            return []
        root = Path(dirs[bucket])
        if not root.exists():
            return []
        results: list[dict] = []
        for dirpath, _dirnames, filenames in os.walk(str(root), followlinks=False):
            for fname in filenames:
                p = Path(dirpath) / fname
                try:
                    rel = p.relative_to(root)
                except ValueError:
                    continue
                key = f"{bucket}/{rel.as_posix()}"
                if not key.startswith(prefix):
                    continue
                st = p.stat()
                results.append({
                    "Key": key,
                    "Size": st.st_size,
                    "LastModified": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc),
                })
        results.sort(key=lambda e: e["Key"])
        return results


# Module-level singleton. Tests can monkeypatch this attribute to swap impls.
media_store: MediaStore = LocalDiskMediaStore()


# ── Compatibility helpers (PR3) ───────────────────────────────────────
#
# Legacy URLs in existing manifests look like:
#     /api/files/hosts/saved/x.png       (bucket missing — implies "outputs")
#     /api/files/ref_img_abc.png         (bucket missing — implies "uploads")
#     /api/files/composite_xxx.png       (bucket missing — implies "outputs")
#
# `resolve_legacy_or_keyed()` lets the file-serving handler accept BOTH
# old (no-bucket) and new (bucket-prefixed) keys without breaking any
# currently-stored result manifest URL.

def resolve_legacy_or_keyed(filename: str) -> Optional[Path]:
    """Resolve a /api/files/{filename:path} request to an absolute file.

    Tries new-style bucket-prefixed keys first; falls back to probing
    each bucket dir with the raw filename (legacy behavior). Returns
    None if nothing matches.
    """
    # New-style: first segment is a known bucket. Use the internal
    # validator to avoid the deprecation warning on local_path_for().
    head, _, _rest = filename.partition("/")
    if head in _bucket_dirs():
        try:
            p = media_store._validate_and_resolve(filename)  # type: ignore[attr-defined]
        except (ValueError, AttributeError):
            return None
        return p if p.exists() else None
    # Legacy: probe every bucket dir with the unmodified filename.
    for root in _bucket_dirs().values():
        candidate = Path(root) / filename
        if candidate.exists():
            return candidate
    return None
