"""Schema validation for eval/step3/fixtures-meta/*.yaml."""
from __future__ import annotations

import pytest
import yaml
from pydantic import ValidationError

from eval.step3.fixture import Fixture, load_fixture


VALID_YAML = """
fixture_id: fixture-01-calm-intro
profile: calm_product_intro
source:
  url: "https://example.com/clip"
  extracted_at: "2026-04-25T14:00:00+09:00"
audio:
  file: uploads/eval-step3/fixtures/fixture-01-calm-intro/audio.mp3
  duration_sec: 10.4
  sample_rate: 16000
reference_frame:
  file: uploads/eval-step3/fixtures/fixture-shared/reference.png
notes: "broadcast-quality"
"""


def test_valid_fixture_loads(tmp_path):
    yaml_path = tmp_path / "fixture-01.yaml"
    yaml_path.write_text(VALID_YAML)
    fx = load_fixture(yaml_path)
    assert fx.fixture_id == "fixture-01-calm-intro"
    assert fx.audio.sample_rate == 16000
    assert fx.reference_frame.file.endswith("reference.png")


def test_missing_required_field_loud_fails():
    raw = yaml.safe_load(VALID_YAML)
    del raw["audio"]
    with pytest.raises(ValidationError):
        Fixture.model_validate(raw)


def test_wrong_type_loud_fails():
    raw = yaml.safe_load(VALID_YAML)
    raw["audio"]["sample_rate"] = "sixteen-thousand"  # not an int
    with pytest.raises(ValidationError):
        Fixture.model_validate(raw)


def test_unknown_field_loud_fails():
    """extra='forbid' should reject typos so we don't get silent drift."""
    raw = yaml.safe_load(VALID_YAML)
    raw["unknown_field"] = "oops"
    with pytest.raises(ValidationError):
        Fixture.model_validate(raw)
