"""Shared pytest fixtures for HostStudio migration tests."""
from __future__ import annotations

import pytest


@pytest.fixture
def uploads_dir(tmp_path):
    """Isolated UPLOADS_DIR for each test."""
    d = tmp_path / "uploads"
    d.mkdir()
    return d


@pytest.fixture
def outputs_dir(tmp_path):
    """Isolated OUTPUTS_DIR for each test."""
    d = tmp_path / "outputs"
    d.mkdir()
    return d


@pytest.fixture
def examples_dir(tmp_path):
    """Isolated EXAMPLES_DIR for each test."""
    d = tmp_path / "examples"
    d.mkdir()
    return d
