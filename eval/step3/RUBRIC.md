# Step 3 Motion Rubric

Binary gate (drives G2 decision):

- **would_show_to_customer** — true/false: "Would I show this clip to the customer as demo material?"

Diagnostic dimensions (0-4, root-cause only, do not gate):

- **mouth_over_articulation** — 0 (natural) → 4 (cartoonishly exaggerated)
- **body_motion_naturalness** — 0 (jerky/unnatural) → 4 (natural, still or subtly gestural)
- **lip_sync_tightness** — 0 (obvious desync) → 4 (tight sync)
- **identity_preservation** — 0 (morphed face) → 4 (identity held across the clip)

## How to score a run

1. Open `eval/step3/results/<run-id>/blind/` — contains UUID-named MP4s. Do NOT open `_blind_map.json`.
2. Read `_shuffle.json` — scoring order is the `order` array. Score in that sequence so bias from fatigue/adaptation is distributed evenly across configs.
3. For each UUID, create an entry in `scores.json`:

```json
{
  "scores": {
    "<uuid>": {
      "would_show_to_customer": true,
      "mouth_over_articulation": 1,
      "body_motion_naturalness": 3,
      "lip_sync_tightness": 3,
      "identity_preservation": 4,
      "notes": ""
    },
    ...
  }
}
```

4. After all UUIDs are scored, run the join:

```bash
python -m eval.step3.join_scores \
  --run-dir eval/step3/results/<run-id>
```

(The join helper reads `_blind_map.json` + `scores.json` and emits `joined_scores.json` + a yes-rate summary. See `eval/step3/rubric.py:join_scores`.)

## Decision gate (per spec v3 §4.4)

- Winner yes-rate ≥ 4/6 AND ≥ baseline + 2 → commit winning prompt to `config.FLASHTALK_OPTIONS["default_prompt"]`.
- Winner yes-rate = baseline → prompt lever confirmed weak, pivot to S3-E Hallo2.
- Winner yes-rate < baseline → revert, pivot to S3-E.

**Baseline-sensitivity exception:** if baseline ≥ 3/6, downgrade the delta threshold to baseline + 1 and record the downgrade in the run manifest. Do not shift it after scoring.
