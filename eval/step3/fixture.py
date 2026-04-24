"""Fixture metadata schema + loader for step3-motion eval (spec v3 §3.2)."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel, ConfigDict


class FixtureSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str
    extracted_at: datetime


class FixtureAudio(BaseModel):
    model_config = ConfigDict(extra="forbid")
    file: str
    duration_sec: float
    sample_rate: int


class FixtureReferenceFrame(BaseModel):
    model_config = ConfigDict(extra="forbid")
    file: str


class Fixture(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fixture_id: str
    profile: str
    source: FixtureSource
    audio: FixtureAudio
    reference_frame: FixtureReferenceFrame
    notes: Optional[str] = None


def load_fixture(yaml_path: str | Path) -> Fixture:
    with open(yaml_path, "r", encoding="utf-8") as f:
        return Fixture.model_validate(yaml.safe_load(f))


def load_fixtures(meta_dir: str | Path) -> list[Fixture]:
    meta_dir = Path(meta_dir)
    return [load_fixture(p) for p in sorted(meta_dir.glob("*.yaml"))]
