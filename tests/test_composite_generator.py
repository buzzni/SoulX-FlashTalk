"""Unit tests for modules.composite_generator helpers."""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest
from PIL import Image


def _write_solid_rgb_png(path: str, color=(123, 45, 67), size=(64, 64)) -> None:
    Image.new("RGB", size, color).save(path, "PNG")


def _make_rgba_with_alpha(size=(64, 64)) -> Image.Image:
    """RGBA image: opaque red square in center, transparent everywhere else."""
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    inner = Image.new("RGBA", (32, 32), (200, 30, 30, 255))
    img.paste(inner, (16, 16))
    return img


def test_preprocess_product_passthrough_when_rembg_off(tmp_path):
    """apply_rembg=False returns the original path unchanged."""
    from modules.composite_generator import _preprocess_product

    src = tmp_path / "src.png"
    _write_solid_rgb_png(str(src))
    out = _preprocess_product(str(src), str(tmp_path / "tmp"), apply_rembg=False)
    assert out == str(src)


def test_preprocess_product_flattens_rgba_onto_white(tmp_path):
    """rembg output (RGBA with alpha) is flattened to RGB-on-white before save."""
    from modules.composite_generator import _preprocess_product

    src = tmp_path / "src.png"
    _write_solid_rgb_png(str(src))
    rgba = _make_rgba_with_alpha()

    with patch("modules.image_compositor._remove_bg", return_value=rgba) as mock_remove:
        out_path = _preprocess_product(str(src), str(tmp_path / "tmp"), apply_rembg=True)

    mock_remove.assert_called_once()
    assert mock_remove.call_args.kwargs.get("kind") == "product" or (
        len(mock_remove.call_args.args) >= 2 and mock_remove.call_args.args[1] == "product"
    )
    assert os.path.exists(out_path)
    saved = Image.open(out_path)
    assert saved.mode == "RGB", f"expected RGB after flatten, got {saved.mode}"
    # Corners were transparent in the source RGBA → should be white after flatten
    for corner in [(0, 0), (saved.width - 1, 0), (0, saved.height - 1), (saved.width - 1, saved.height - 1)]:
        assert saved.getpixel(corner) == (255, 255, 255), f"corner {corner} not white"
    # Center pixel was opaque red → should remain near-red (allow tiny PNG round-trip drift)
    cx, cy = saved.width // 2, saved.height // 2
    r, g, b = saved.getpixel((cx, cy))
    assert r > 150 and g < 80 and b < 80, f"center pixel lost color: {(r, g, b)}"


def test_preprocess_product_handles_non_rgba_rembg_return(tmp_path):
    """Defensive: if rembg returns RGB (rare), the flatten step still works."""
    from modules.composite_generator import _preprocess_product

    src = tmp_path / "src.png"
    _write_solid_rgb_png(str(src))
    rgb_only = Image.new("RGB", (32, 32), (10, 20, 30))

    with patch("modules.image_compositor._remove_bg", return_value=rgb_only):
        out_path = _preprocess_product(str(src), str(tmp_path / "tmp"), apply_rembg=True)

    saved = Image.open(out_path)
    assert saved.mode == "RGB"
