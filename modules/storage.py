"""Media storage abstraction (PR3).

The DB never stores absolute filesystem paths. It stores `storage_key` —
a bucket-prefixed relative key like `outputs/hosts/saved/host_x_s42.png`
or `uploads/ref_img_abc.png`. `LocalDiskMediaStore` resolves keys against
config-driven bucket directories. A future cloud impl swaps `url_for` to
return presigned URLs (and adds a staging/cache layer per codex #4 — that
piece is intentionally deferred).

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
"""
from __future__ import annotations

import secrets
from pathlib import Path
from typing import Iterable, Optional, Protocol

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


class MediaStore(Protocol):
    def save_bytes(self, kind: str, data: bytes, *,
                    suffix: str = "", basename: Optional[str] = None) -> str: ...
    def save_path(self, kind: str, src: Path, *,
                   basename: Optional[str] = None) -> str: ...
    def local_path_for(self, key: str) -> Path: ...
    def url_for(self, key: str) -> str: ...
    def delete(self, key: str) -> bool: ...


class LocalDiskMediaStore:
    """Default backend: writes go straight to local disk under config dirs.

    A future S3 / GCS impl preserves this exact public surface; only
    `url_for()` and the underlying read/write semantics change.
    """

    def _route(self, kind: str) -> tuple[str, str, Path]:
        if kind not in _KIND_PATH:
            raise ValueError(f"unknown media kind: {kind!r}")
        bucket, sub = _KIND_PATH[kind]
        target = Path(_bucket_dirs()[bucket])
        if sub:
            target = target / sub
        return bucket, sub, target

    def _build_key(self, bucket: str, sub: str, basename: str) -> str:
        return "/".join(p for p in (bucket, sub, basename) if p)

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
        import shutil
        src = Path(src)
        bucket, sub, target = self._route(kind)
        if basename is None:
            basename = src.name
        target.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, target / basename)
        return self._build_key(bucket, sub, basename)

    def local_path_for(self, key: str) -> Path:
        """Resolve a storage_key to its absolute on-disk path.

        Raises ValueError on:
        - empty key, or key without bucket prefix
        - unknown bucket
        - any segment equal to '..' (prevent traversal)
        """
        if not key or "/" not in key:
            raise ValueError(f"key must be bucket-prefixed: got {key!r}")
        bucket, _, rest = key.partition("/")
        dirs = _bucket_dirs()
        if bucket not in dirs:
            raise ValueError(f"unknown bucket: {bucket!r}")
        if not rest:
            raise ValueError(f"empty key inside bucket: {key!r}")
        # Reject traversal segments. Strict check: any '..' segment is rejected,
        # even if a real path would resolve safely (defense in depth).
        for seg in rest.split("/"):
            if seg in ("..", "") or seg.strip() == "":
                raise ValueError(f"invalid key segment: {key!r}")
        return Path(dirs[bucket]) / rest

    def url_for(self, key: str) -> str:
        # Trigger validation; ignore returned path (we just want the check).
        self.local_path_for(key)
        return f"/api/files/{key}"

    def delete(self, key: str) -> bool:
        """Delete the file backing `key`. Returns True if a file was removed."""
        path = self.local_path_for(key)
        try:
            path.unlink()
            return True
        except FileNotFoundError:
            return False


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
    # New-style: first segment is a known bucket.
    head, _, _rest = filename.partition("/")
    if head in _bucket_dirs():
        try:
            p = media_store.local_path_for(filename)
        except ValueError:
            return None
        return p if p.exists() else None
    # Legacy: probe every bucket dir with the unmodified filename.
    for root in _bucket_dirs().values():
        candidate = Path(root) / filename
        if candidate.exists():
            return candidate
    return None
