"""Phase 2 — POST /api/composite/generate endpoint."""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.phase2


@pytest.mark.skip(reason="TDD placeholder — happy path")
def test_composite_generate_returns_candidates():
    """POST returns 4 composite candidate paths."""
    ...


@pytest.mark.skip(reason="TDD placeholder — rembg default ON")
def test_rembg_default_on_for_product_images():
    """Product images pre-processed through rembg by default."""
    ...


@pytest.mark.skip(reason="TDD placeholder — rembg toggle OFF via query")
def test_rembg_toggle_off_preserves_background():
    """?rembg=false skips rembg (e.g. food/furniture)."""
    ...


@pytest.mark.skip(reason="TDD placeholder — Korean direction preserved")
def test_korean_direction_preserved_verbatim():
    """composition.direction Korean text sent to backend for ko→en translate."""
    ...


@pytest.mark.skip(reason="TDD placeholder — shot + angle enums")
def test_invalid_shot_enum_returns_400():
    """shot='weird' → 400."""
    ...
