"""HTTP polling eval harness for step3-motion (spec v3 §2.3, §3.4).

Renders the 6-fixture set against a running backend with a given prompt,
downloads the videos, blind-renames them to UUIDs, and writes a manifest
the operator scores against.

Usage:
    python eval/step3/run_eval.py \\
        --config config.yaml \\
        --run-id baseline \\
        --fixtures-meta-dir eval/step3/fixtures-meta \\
        --output-dir eval/step3/results \\
        --backend http://localhost:8001
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import requests
import yaml

from eval.step3.fixture import Fixture, load_fixtures
from eval.step3.rubric import BlindEntry, write_blind_map

TERMINAL_STAGES = {"complete", "error", "cancelled"}
POLL_INTERVAL_SEC = 5.0
POLL_TIMEOUT_SEC = 60 * 60 * 2  # 2h — longest realistic per-fixture render


@dataclass(frozen=True)
class RunConfig:
    config_id: str
    prompt: str  # Empty string → server uses FLASHTALK_OPTIONS default.


def load_config(path: str | Path) -> RunConfig:
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return RunConfig(
        config_id=raw.get("config_id") or Path(path).stem,
        prompt=raw.get("prompt", "") or "",
    )


def short_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], text=True
        ).strip()
    except Exception:
        return "unknown"


def post_generate(
    backend: str,
    fixture: Fixture,
    prompt: str,
) -> str:
    """Submit a render request. Returns task_id."""
    resp = requests.post(
        f"{backend}/api/generate",
        data={
            "audio_source": "upload",
            "audio_path": fixture.audio.file,
            "host_image_path": fixture.reference_frame.file,
            "prompt": prompt,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["task_id"]


def poll_until_terminal(backend: str, task_id: str) -> dict:
    """Block until stage in TERMINAL_STAGES, or timeout. Returns final state."""
    deadline = time.monotonic() + POLL_TIMEOUT_SEC
    while time.monotonic() < deadline:
        resp = requests.get(
            f"{backend}/api/tasks/{task_id}/state", timeout=10
        )
        resp.raise_for_status()
        state = resp.json()
        stage = state.get("stage")
        if stage in TERMINAL_STAGES:
            return state
        time.sleep(POLL_INTERVAL_SEC)
    raise TimeoutError(f"Task {task_id} did not reach terminal stage within {POLL_TIMEOUT_SEC}s")


def fetch_result(backend: str, task_id: str) -> dict:
    resp = requests.get(f"{backend}/api/results/{task_id}", timeout=10)
    resp.raise_for_status()
    return resp.json()


def download_video(backend: str, video_url: str, dest: Path) -> None:
    url = video_url if video_url.startswith("http") else f"{backend}{video_url}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=60) as resp:
        resp.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=64 * 1024):
                f.write(chunk)


def render_one(
    backend: str,
    fixture: Fixture,
    config: RunConfig,
    run_dir: Path,
) -> Optional[Path]:
    """Render one fixture end-to-end. Returns local MP4 path, or None on error."""
    task_id = post_generate(backend, fixture, config.prompt)
    print(f"  [{fixture.fixture_id}] task_id={task_id}", flush=True)
    state = poll_until_terminal(backend, task_id)
    if state.get("stage") != "complete":
        print(
            f"  [{fixture.fixture_id}] non-complete terminal: "
            f"stage={state.get('stage')} error={state.get('error')}",
            file=sys.stderr,
        )
        return None
    manifest = fetch_result(backend, task_id)
    video_dest = run_dir / "videos" / f"{fixture.fixture_id}.mp4"
    download_video(backend, manifest["video_url"], video_dest)
    return video_dest


def build_blind_dir(
    videos: list[tuple[str, str, Path]],  # (fixture_id, config_id, video_path)
    run_dir: Path,
    seed: int,
) -> tuple[list[BlindEntry], list[str]]:
    """Copy videos under blind/ with UUID names, return mapping + shuffled order."""
    blind_dir = run_dir / "blind"
    blind_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    entries = []
    for fixture_id, config_id, video_path in videos:
        blind_uuid = uuid.uuid4().hex
        shutil.copy2(video_path, blind_dir / f"{blind_uuid}.mp4")
        entries.append(BlindEntry(blind_uuid=blind_uuid, fixture_id=fixture_id, config_id=config_id))
    order = [e.blind_uuid for e in entries]
    rng.shuffle(order)
    return entries, order


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--config", required=True, help="YAML with config_id + prompt")
    p.add_argument("--run-id", required=True)
    p.add_argument("--fixtures-meta-dir", default="eval/step3/fixtures-meta")
    p.add_argument("--output-dir", default="eval/step3/results")
    p.add_argument("--backend", default="http://localhost:8001")
    p.add_argument("--shuffle-seed", type=int, default=42)
    args = p.parse_args()

    config = load_config(args.config)
    fixtures = load_fixtures(args.fixtures_meta_dir)
    if not fixtures:
        print(f"No fixtures in {args.fixtures_meta_dir}", file=sys.stderr)
        return 2

    run_dir = Path(args.output_dir) / args.run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    rendered: list[tuple[str, str, Path]] = []
    for fixture in fixtures:
        print(f"Rendering {fixture.fixture_id} with config={config.config_id}", flush=True)
        video_path = render_one(args.backend, fixture, config, run_dir)
        if video_path is not None:
            rendered.append((fixture.fixture_id, config.config_id, video_path))

    blind_entries, shuffled_order = build_blind_dir(rendered, run_dir, args.shuffle_seed)
    write_blind_map(blind_entries, run_dir / "_blind_map.json")
    with open(run_dir / "_shuffle.json", "w", encoding="utf-8") as f:
        json.dump({"seed": args.shuffle_seed, "order": shuffled_order}, f, indent=2)

    manifest = {
        "run_id": args.run_id,
        "config_id": config.config_id,
        "prompt": config.prompt,
        "commit": short_commit(),
        "backend": args.backend,
        "fixtures": [f.fixture_id for f in fixtures],
        "rendered": [r[0] for r in rendered],
        "skipped": [f.fixture_id for f in fixtures if f.fixture_id not in {r[0] for r in rendered}],
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    with open(run_dir / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print(f"Wrote {run_dir}/manifest.json, {len(rendered)}/{len(fixtures)} rendered")
    return 0 if len(rendered) == len(fixtures) else 1


if __name__ == "__main__":
    sys.exit(main())
