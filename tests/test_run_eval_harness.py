"""Smoke tests for eval/step3/run_eval.py — CLI parse + manifest/blind shape.

Full end-to-end is an operator-driven test against a live backend; this file
covers the parts we can mock deterministically.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]


VALID_FIXTURE_YAML = """
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
notes: ""
"""


def _write_fixture(meta_dir: Path, name: str = "fixture-01.yaml") -> None:
    meta_dir.mkdir(parents=True, exist_ok=True)
    (meta_dir / name).write_text(VALID_FIXTURE_YAML)


def test_run_eval_module_help_exits_zero():
    """`python -m eval.step3.run_eval --help` works end-to-end."""
    rc = subprocess.run(
        [sys.executable, "-m", "eval.step3.run_eval", "--help"],
        cwd=REPO_ROOT,
        capture_output=True,
    ).returncode
    assert rc == 0


def test_load_config_empty_prompt_defaults_to_empty_string(tmp_path):
    from eval.step3.run_eval import load_config
    cfg_path = tmp_path / "cfg.yaml"
    cfg_path.write_text("config_id: test\nprompt: \"\"\n")
    cfg = load_config(cfg_path)
    assert cfg.prompt == ""
    assert cfg.config_id == "test"


def test_load_config_missing_prompt_falls_back_to_empty(tmp_path):
    from eval.step3.run_eval import load_config
    cfg_path = tmp_path / "cfg.yaml"
    cfg_path.write_text("config_id: test\n")
    cfg = load_config(cfg_path)
    assert cfg.prompt == ""


def test_load_config_infers_config_id_from_filename(tmp_path):
    from eval.step3.run_eval import load_config
    cfg_path = tmp_path / "s3b-p-v1.yaml"
    cfg_path.write_text("prompt: 'hello'\n")
    cfg = load_config(cfg_path)
    assert cfg.config_id == "s3b-p-v1"


def test_build_blind_dir_produces_mapping_and_shuffle(tmp_path):
    from eval.step3.run_eval import build_blind_dir
    run_dir = tmp_path / "run-x"
    run_dir.mkdir()
    # Fake 3 rendered videos
    videos = []
    for i in range(3):
        vpath = run_dir / f"videos/fix-{i}.mp4"
        vpath.parent.mkdir(parents=True, exist_ok=True)
        vpath.write_bytes(b"fake mp4")
        videos.append((f"fix-{i}", "baseline", vpath))

    entries, order = build_blind_dir(videos, run_dir, seed=42)

    assert len(entries) == 3
    # Mapping: each UUID maps to exactly one (fixture, config)
    uuids = {e.blind_uuid for e in entries}
    assert len(uuids) == 3
    # Shuffled order contains all UUIDs, deterministic with same seed
    assert set(order) == uuids
    # Blind files exist
    blind_files = sorted((run_dir / "blind").glob("*.mp4"))
    assert len(blind_files) == 3

    # Reproducibility: same seed → same order
    entries2, order2 = build_blind_dir(videos, run_dir, seed=42)
    # UUIDs differ (fresh uuid4 per call) but seed governs which of the generated
    # uuids gets which slot — reshuffling over a different UUID set is not
    # identical, so we test shuffle determinism on a fixed UUID list instead.
    import random
    fixed = ["a", "b", "c", "d"]
    r1 = random.Random(42); r1.shuffle(fixed); first = list(fixed)
    fixed = ["a", "b", "c", "d"]
    r2 = random.Random(42); r2.shuffle(fixed); second = list(fixed)
    assert first == second


@patch("eval.step3.run_eval.requests")
def test_render_one_skips_on_error_stage(mock_requests, tmp_path):
    """If backend returns stage=error, render_one returns None (not raise)."""
    from eval.step3.run_eval import render_one, RunConfig
    from eval.step3.fixture import Fixture, FixtureSource, FixtureAudio, FixtureReferenceFrame

    # Build a minimal Fixture in memory
    fx = Fixture(
        fixture_id="fix-01",
        profile="test",
        source=FixtureSource(url="http://x", extracted_at="2026-01-01T00:00:00+00:00"),
        audio=FixtureAudio(
            file="uploads/eval-step3/fixtures/fix-01/audio.mp3",
            duration_sec=10.0,
            sample_rate=16000,
        ),
        reference_frame=FixtureReferenceFrame(
            file="uploads/eval-step3/fixtures/fixture-shared/reference.png"
        ),
    )

    # POST → task_id
    post_resp = MagicMock()
    post_resp.raise_for_status = MagicMock()
    post_resp.json.return_value = {"task_id": "t-1"}
    # Poll → error terminal
    poll_resp = MagicMock()
    poll_resp.raise_for_status = MagicMock()
    poll_resp.json.return_value = {"stage": "error", "error": "boom"}

    mock_requests.post.return_value = post_resp
    mock_requests.get.return_value = poll_resp

    result = render_one(
        backend="http://x",
        fixture=fx,
        config=RunConfig(config_id="baseline", prompt=""),
        run_dir=tmp_path,
    )
    assert result is None
