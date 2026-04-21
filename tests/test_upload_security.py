"""Phase 0 — Upload security hardening."""
from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi import HTTPException

pytestmark = pytest.mark.phase0


# ---- Active tests ----


def test_safe_upload_path_accepts_uploads_dir(uploads_dir):
    from utils.security import safe_upload_path
    import config

    target = Path(uploads_dir) / "x.png"
    target.touch()
    resolved = safe_upload_path(
        str(target),
        roots=(str(uploads_dir),),
    )
    assert resolved == str(target.resolve())


def test_safe_upload_path_rejects_absolute_escape():
    from utils.security import safe_upload_path
    import config

    with pytest.raises(HTTPException) as exc:
        safe_upload_path("/etc/passwd", roots=(config.UPLOADS_DIR,))
    assert exc.value.status_code == 400


def test_safe_upload_path_rejects_dotdot_traversal(uploads_dir):
    from utils.security import safe_upload_path

    with pytest.raises(HTTPException) as exc:
        safe_upload_path(
            str(uploads_dir / "../../etc/passwd"),
            roots=(str(uploads_dir),),
        )
    assert exc.value.status_code == 400


def test_safe_upload_path_accepts_any_safe_root(uploads_dir, outputs_dir, examples_dir):
    from utils.security import safe_upload_path

    roots = (str(uploads_dir), str(outputs_dir), str(examples_dir))
    # All three roots should be valid anchors
    for root in roots:
        f = Path(root) / "x.txt"
        f.touch()
        assert safe_upload_path(str(f), roots=roots) == str(f.resolve())
        f.unlink()


def test_safe_upload_path_rejects_empty():
    from utils.security import safe_upload_path

    with pytest.raises(HTTPException):
        safe_upload_path("")


def test_safe_upload_path_rejects_prefix_collision(tmp_path):
    """'/tmp/foo' must NOT match '/tmp/foobar' as root prefix."""
    from utils.security import safe_upload_path

    root = tmp_path / "foo"
    root.mkdir()
    sibling = tmp_path / "foobar"
    sibling.mkdir()
    evil = sibling / "x.txt"
    evil.touch()
    with pytest.raises(HTTPException):
        safe_upload_path(str(evil), roots=(str(root),))


def test_config_has_safe_roots_tuple():
    import config

    assert isinstance(config.SAFE_ROOTS, tuple)
    assert config.UPLOADS_DIR in config.SAFE_ROOTS
    assert config.OUTPUTS_DIR in config.SAFE_ROOTS
    assert config.EXAMPLES_DIR in config.SAFE_ROOTS


def test_config_max_upload_bytes_is_20mb():
    import config

    assert config.MAX_UPLOAD_BYTES == 20 * 1024 * 1024


def test_enforce_content_length_rejects_oversize():
    from utils.security import enforce_content_length
    import config

    with pytest.raises(HTTPException) as exc:
        enforce_content_length(config.MAX_UPLOAD_BYTES + 1)
    assert exc.value.status_code == 413


def test_enforce_content_length_allows_under_limit():
    from utils.security import enforce_content_length

    # No exception
    enforce_content_length(1024)
    enforce_content_length(None)  # Missing header OK (fallback to chunked check)


def test_api_files_no_project_root_fallback():
    """app.py:/api/files no longer has PROJECT_ROOT fallback (Phase 0 Critical #1)."""
    src = Path(__file__).parent.parent / "app.py"
    text = src.read_text(encoding="utf-8")
    # Old pattern removed
    assert "filepath = os.path.join(config.PROJECT_ROOT, filename)" not in text
    # New pattern present
    assert "No PROJECT_ROOT fallback" in text or "Critical #1" in text


# ---- Placeholders (need FastAPI TestClient) ----


@pytest.mark.skip(reason="TDD placeholder — TestClient integration")
def test_upload_endpoint_rejects_non_image_via_magic_byte():
    ...


@pytest.mark.skip(reason="TDD placeholder — TestClient integration")
def test_upload_endpoint_rejects_oversize_via_content_length_header():
    ...


@pytest.mark.skip(reason="TDD placeholder — TestClient integration")
def test_generate_rejects_body_field_absolute_path():
    ...
