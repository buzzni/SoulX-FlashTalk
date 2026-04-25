# Step 3 Motion Eval (G2)

Eval harness + S3-B sweep for the FlashTalk motion track. Implements `docs/step3-motion-spec.md` v3.

## Layout

```
eval/step3/
  fixtures-meta/            YAML fixture metadata (in git)
  configs/                  Sweep prompt configs (in git)
  results/                  Rendered videos + manifests + scores (gitignored per-run)
  fixture.py                Pydantic loader
  rubric.py                 Score schema + blind-map join helpers
  run_eval.py               HTTP polling eval harness
  join_scores.py            CLI to join blind UUIDs → (fixture, config) pairs
  RUBRIC.md                 Scoring instructions
  README.md                 This file
```

## One-time setup

1. **Source the 6 fixtures** — spec §3.1. Extract MP3s from real live-commerce videos into the **backend repo's** `uploads/eval-step3/fixtures/fixture-0{1..6}-*/audio.mp3`. Place the shared reference image at `uploads/eval-step3/fixtures/fixture-shared/reference.png`.

   > Fixtures live in `uploads/` because `utils/security.py:safe_upload_path` enforces `SAFE_ROOTS` on every request. Paths outside silently fall back to defaults and produce garbage runs.

2. **Write `eval/step3/fixtures-meta/fixture-0{1..6}-*.yaml`** — schema in `fixture.py` (`Fixture` model). Pydantic `extra="forbid"` means typos loud-fail at load.

## Running a sweep

From the repo root, with the backend running on `localhost:8001`:

```bash
# Baseline (current config default prompt)
python -m eval.step3.run_eval \
  --config eval/step3/configs/s3b-p-v0.yaml \
  --run-id baseline

# Full S3-B sweep (3 configs × 6 fixtures, ~4h wall-clock)
python scripts/step3_motion/s3b_prompt_sweep.py
```

Renders produce:
- `eval/step3/results/<run-id>/videos/<fixture_id>.mp4` — canonical per-fixture output
- `eval/step3/results/<run-id>/blind/<uuid>.mp4` — blind-renamed for scoring
- `eval/step3/results/<run-id>/_blind_map.json` — UUID ↔ (fixture, config) mapping, **do not peek during scoring**
- `eval/step3/results/<run-id>/_shuffle.json` — deterministic scoring order (seed 42 by default)
- `eval/step3/results/<run-id>/manifest.json` — run metadata (commit, timestamps, rendered/skipped list)

## Scoring

See `RUBRIC.md`. Write `eval/step3/results/<run-id>/scores.json`, then:

```bash
python -m eval.step3.join_scores --run-dir eval/step3/results/baseline
```

## Cross-worktree note

The backend resolves `audio_path` / `host_image_path` against its own CWD (the worktree the uvicorn process was launched from). If you're running this eval against the `main`-worktree backend, the fixtures must physically live under that worktree's `uploads/eval-step3/`, not this worktree's. A symlink works:

```bash
ln -s /opt/home/jack/workspace/SoulX-FlashTalk/uploads/eval-step3 \
      /opt/home/jack/workspace/SoulX-FlashTalk-step3-motion/uploads/eval-step3
```
