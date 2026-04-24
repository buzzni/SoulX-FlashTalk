# G2 step3-motion — Implementation Spec (v3, post-2nd-Codex-review)

**Parent plan:** `docs/integration-plan.md` §6 (FlashTalk motion track) — **superseded for G2 scope by this spec** (see Appendix B).
**Branch:** `step3-motion`
**Time-box:** 2 weeks from G2 start
**Status:** v3 — rewritten after 2nd Codex review identified one fatal architectural redundancy in v2 and 8 smaller issues.

---

## 0. What changed from v2

v2 fixed v1's 2 fatal findings but introduced a new architectural redundancy, plus left 8 smaller issues open. v3 addresses all of them.

**Fatal (new in v2 → fixed in v3):**
- v2 proposed adding a `prompt_override` Form parameter to `/api/generate`. That was wrong — `app.py:1148` already declares `prompt: Optional[str] = Form(None)` and `:1234-1235` already falls back to the config default when empty. v3 drops the new param entirely. Eval harness POSTs the existing `prompt` field. **Zero code changes to `/api/generate`.**

**Smaller (v2 → v3):**
1. S3-A dropped in v2 but dead code still live in `app.py:490-498`, `modules/conversation_generator.py:102-110`, `config.py:51-54`. v3 removes all three so baselines aren't contaminated by mathematically-null pre-attenuation.
2. Appendix B in v2 understated parent-plan contradictions (4 listed, 7 actual). v3 calls the spec a replacement, lists all 7, and adds pointer banners to `integration-plan.md` §6 + §14.1 via a separate small PR on main.
3. Operator scoring noise was the real risk Codex flagged, not model stochasticity. v3 adds blind scoring + order shuffling to §3.3 + §3.4. No repeat runs (FlashTalk is `seed=9999` deterministic; repeats produce bit-identical output).
4. §10 exit criteria reframed: primary deliverable is **ceiling diagnosis**, not improvement. Improvement (winning prompt or Hallo2 swap) is possible secondary.
5. Reference frame rationale made explicit in §3.1: fixed reference controls identity so audio is the sole variable. Demo-matching validation (per-fixture reference) is explicitly out of G2 scope.
6. Hallo2 POC GPU isolation in §5.2: backend holds `CUDA_VISIBLE_DEVICES=1,3`, so POC runs require backend offline during the 2-3 POC days.
7. Decision gate baseline sensitivity in §4.4: `≥4/6 AND ≥ baseline + 2` becomes unreachable if baseline is ≥4. Conditional recheck after baseline is scored.
8. Appendix A's BS.1770 caveat tightened from vague "nonlinear residual" to "blocks crossing the absolute -70 LUFS gate".

**Net effect on G2:** same 2-week timebox. Fewer code changes overall (code cleanup and spec-only). Honest about what 2 weeks can actually produce.

---

## 1. Revised scope

G2 has **1 in-scope lever** and **1 contingency path**:

- **S3-B** FlashTalk positive-prompt sweep (paper suggests modest effect at best)
- **S3-E** Hallo2 open-source model POC (likely primary deliverable given S3-A dead + S3-B expected weak)

Dropped: S3-A, sample_neg_prompt, CFG sweep, sampling_steps sweep, sample_shift sweep, reference-frame preprocessing, commercial model POC.

**Success criteria (demo-phase):** for ≥4 of 6 fixtures, rubric "would I show this to customer?" = yes after the winning change. Baseline expected ≤2/6. Target delta ≥ +2.

**Honest primary deliverable:** ceiling diagnosis. If neither S3-B nor Hallo2 clears 4/6, the motion problem is downstream of G2's engineering reach; the record produced is the evidence for that.

**Failure → accept FlashTalk ceiling.** Pivot to commercial model (outside G2 budget) or accept current quality for demo.

---

## 2. Architecture

### 2.1 Reusing the existing `prompt` field (v2 fix correction)

v2 error: proposed a new `prompt_override` Form param.
v3 reality: `app.py:1148` already has `prompt: Optional[str] = Form(None)` with config-default fallback at `:1234-1235`. The eval harness just POSTs `prompt=<candidate text>` per request.

**Zero code changes to `/api/generate`.** No new Form param, no new tests for the param (there's nothing to test), no regression risk.

### 2.2 Fixtures under UPLOADS_DIR (same as v2)

`utils/security.py`'s `safe_upload_path` enforces paths resolve to `UPLOADS_DIR`, `OUTPUTS_DIR`, or `EXAMPLES_DIR`. Anything outside silently falls back to defaults (`app.py:1168-1177`). Eval fixtures therefore live under `uploads/`.

```
uploads/                               ← already in SAFE_ROOTS
  eval-step3/
    fixtures/
      fixture-01-calm-intro/audio.mp3
      ...
      fixture-shared/reference.png
```

`metadata.yaml` + scoring artifacts stay in repo tree (`eval/step3/fixtures-meta/`). Audio/image binaries gitignored.

### 2.3 Eval harness as polling HTTP client (same as v2)

`/api/generate` returns `{task_id, message, queue_position}` — not a video path. Harness:

```
1. POST /api/generate (with prompt=<candidate>, audio_path=<fixture>, host_image_path=<reference>)  →  task_id
2. Poll  /api/tasks/{task_id}/state   every 5s until status ∈ {completed, error, cancelled}
3. GET   /api/results/{task_id}       →  video URL
4. Download MP4 to results/{run_id}/videos/
5. Blind-rename to blind/{random-uuid}.mp4 and write mapping JSON (see §3.4)
```

---

## 3. S3-0 eval baseline

### 3.1 Fixture set + reference frame rationale

6 fixtures extracted from real live-commerce videos as MP3 (쿠팡라이브/네이버쇼핑라이브). Profile guide:

| # | Audio profile | Length | Failure mode targeted |
|---|---|---|---|
| 1 | Calm product intro | 10s | Baseline "normal" |
| 2 | Animated product pitch | 15s | Over-articulation stress |
| 3 | Calm explainer | 20s | Sustained quality across chunks |
| 4 | Numeric-heavy pricing | 15s | Mixed-language + numeric lip-sync |
| 5 | Short salutation | 6s | Sub-chunk length variance |
| 6 | Low-energy aside | 12s | Audio energy ≠ over-articulation control |

**Fixed reference frame across all 6 fixtures.** Rationale: controls identity so audio is the sole variable driving motion differences. This is correct for measuring lever effect but diverges from real demo conditions (per-customer composite image + customer audio). **Demo-matching validation is explicitly out of G2 scope** — if G2 finds a winning lever, a separate small validation run on real demo inputs precedes commit to production.

### 3.2 Metadata schema (pydantic-validated)

`eval/step3/fixtures-meta/fixture-01-calm-intro.yaml`:

```yaml
fixture_id: fixture-01-calm-intro
profile: calm_product_intro
source:
  url: "https://shoppinglive.naver.com/..."
  extracted_at: "2026-04-25T14:00:00+09:00"
audio:
  file: uploads/eval-step3/fixtures/fixture-01-calm-intro/audio.mp3
  duration_sec: 10.4
  sample_rate: 16000
reference_frame:
  file: uploads/eval-step3/fixtures/fixture-shared/reference.png
notes: "Broadcast-quality audio, calm female host voice"
```

`eval/step3/fixture.py` loads + validates via `pydantic.BaseModel`. Missing required field / wrong type → hard fail at load.

### 3.3 Rubric + blind scoring protocol

Binary gate dimension (per `integration-plan.md §14.3`):
- `would_show_to_customer`: true/false

Diagnostic dimensions (0-4, for root-cause not gating):
- `mouth_over_articulation`, `body_motion_naturalness`, `lip_sync_tightness`, `identity_preservation`

**Blind scoring protocol (new in v3):**
- Harness copies each output video to `results/{run_id}/blind/{uuid4}.mp4`.
- Mapping `{uuid → (fixture_id, config_id)}` written to `results/{run_id}/_blind_map.json` (not viewed during scoring).
- Operator scores against UUID filenames only. No config hints visible.
- After scoring, harness joins scores back to `(fixture_id, config_id)` tuples.
- Order: video list is shuffled with a recorded random seed so runs are reproducible if re-scored.

Why: Codex flagged scoring-side bias as the real noise risk. FlashTalk itself is deterministic at fixed seed, so model repeats are pointless. Blind + shuffle is the cheap, correct mitigation.

### 3.4 `run_eval.py` (HTTP polling client + blinder)

```
python eval/step3/run_eval.py \
  --config <yaml-or-stdin>      \  # e.g. "prompt: '...candidate text...'"
  --run-id <string>             \
  --fixtures-meta-dir eval/step3/fixtures-meta \
  --output-dir eval/step3/results \
  --backend http://localhost:8001
```

Per fixture:
1. POST `/api/generate` form: `host_image_path`, `audio_source=upload`, `audio_path`, `prompt` (from config — empty = server default).
2. Poll `/api/tasks/{task_id}/state` every 5s until terminal.
3. On completed, GET `/api/results/{task_id}`.
4. Download MP4 to `results/{run_id}/videos/{fixture_id}.mp4`.
5. Copy to `results/{run_id}/blind/{uuid4}.mp4` and append mapping.

After all fixtures:
6. Shuffle blind filenames with seeded RNG, write `_shuffle.json` (reproducible).
7. Write `manifest.json` (fixtures, config hash, code commit, timestamps).

**Expected wall-clock per fixture:**
- 10s audio × 3 chunks × ~75s/chunk = ~225s = ~4 min
- 6 fixtures of varying length (~78s total audio, ~60 chunks): **~75 min wall-clock per sweep config** (serial, single worker).

---

## 4. S3-B positive-prompt sweep

Only active G2 lever (v3).

### 4.1 Code changes

**None.** Eval harness uses existing `prompt` Form field. See §2.1.

`modules/conversation_generator.py` path NOT updated (MultiTalk conversation — out of G2 scope).

### 4.2 Candidate prompts (3)

Current FLASHTALK_OPTIONS["default_prompt"] (`config.py:42-47`) is p-v0:

> "A person is talking with subtle, natural hand gestures and minimal, stable body movement. The lips move softly and naturally in sync with speech, not exaggerated. Only the foreground character moves; the background remains static."

| ID | Direction | Text |
|---|---|---|
| p-v0 | Control | *(current FLASHTALK_OPTIONS["default_prompt"], config.py:42-47)* |
| p-v1 | Closed-mouth emphasis | "A person speaks with small natural lip movements. The mouth closes completely between syllables. Hands rest at the sides with no gesturing. Body remains relaxed and still. Background is completely stationary." |
| p-v2 | Negation-as-positive | "A person speaks clearly. Lips open only slightly, never wide. Hands stay at the sides, not gesturing. Body stays still, not swaying. Background is static." |

Dropped from v1: p-v1-subtle-stronger (redundant with p-v1), p-v3-korean-context (speculative), p-v4-negative-in-positive (same intent as p-v2).

### 4.3 Sweep execution

`scripts/step3_motion/s3b_prompt_sweep.py`:
- 3 configs × 6 fixtures
- Per-sweep-config wall-clock: ~75 min
- Total: ~225 min = 3h 45m
- Blind-scoring: 18 videos × ~30s each = ~10 min human

### 4.4 Decision gate (end of S3-B scoring)

Primary gate:
- Winner's yes-rate ≥ 4/6 **AND** ≥ baseline + 2 → commit winning prompt to `config.FLASHTALK_OPTIONS["default_prompt"]`, G2 success on S3-B.
- Winner's yes-rate = baseline (no effect) → FlashTalk prompt lever confirmed weak, pivot to S3-E Hallo2.
- Winner's yes-rate < baseline → revert, pivot to S3-E.

**Baseline sensitivity check:** if baseline is already ≥3/6, the `baseline + 2` threshold becomes unreasonable (≥5/6 needed with only 3 variants). Action: after baseline is scored, if it is ≥3/6, downgrade threshold to `baseline + 1` and record the downgrade in the manifest as an honest adjustment rather than goal-post-shifting mid-sweep.

---

## 5. S3-E Hallo2 POC

Given S3-A dropped and S3-B effect expected modest, S3-E becomes the likely primary deliverable of G2.

### 5.1 Why Hallo2

| Candidate | Release | VRAM | License | Why |
|---|---|---|---|---|
| **Hallo2** | 2024 Q4 | ~20GB | Apache 2.0 | Strongest recent quality signal, audio-driven, fits GPU |
| EchoMimic | 2024 Q3 | ~16GB | Apache 2.0 | Fallback if Hallo2 setup fails |
| MuseTalk | 2024 | ~10GB | MIT | Realtime focus, lower quality ceiling |

### 5.2 POC protocol + GPU isolation

**GPU isolation (v3 addition):** the running backend holds `CUDA_VISIBLE_DEVICES=1,3` per the project's launch convention. Hallo2 POC therefore requires the backend to be **offline** during the 2-3 POC days. Practical: tmux detach + shutdown, run POC on one or both GPUs, restart backend when POC concludes. Demo availability pauses during POC — accepted cost since demo-phase isn't contract-gated.

Day 1:
1. Shut down backend. Clone Hallo2 repo, download checkpoints (~15GB, 1-2h).
2. Resolve Python deps in **separate venv** (`venv-hallo2/`) — likely conflicts with SoulX-FlashTalk venv.
3. Run Hallo2 inference on 1 fixture (fixture-02, animated pitch — most likely to show delta).

Day 2:
4. Extend to all 6 fixtures if Day 1 works.
5. Blind-score vs FlashTalk S3-B winner output.
6. Decision: commit to Hallo2 swap? → follow-up G2-B spec.

Day 3 (buffer):
7. If Day 1 fails by noon → try EchoMimic same day (same venv hygiene).
8. If both fail by end Day 1 → concede motion ceiling.

**Time-box:** 3 days hard cap. If no working alternative by Day 3, G2 exits with "FlashTalk ceiling, no free alternative clears the bar" conclusion.

---

## 6. Per-PR breakdown

### PR-A: S3-0 + S3-B + S3-A dead-code cleanup

**Files added:**
- `uploads/eval-step3/fixtures/fixture-{01..06}-*/audio.mp3` (gitignored)
- `uploads/eval-step3/fixtures/fixture-shared/reference.png` (gitignored)
- `eval/step3/fixtures-meta/fixture-{01..06}.yaml` (metadata, in git)
- `eval/step3/fixture.py` (pydantic loader)
- `eval/step3/rubric.py` (score schema + I/O + blind join)
- `eval/step3/run_eval.py` (HTTP polling client + blinder)
- `eval/step3/RUBRIC.md`
- `eval/step3/README.md`
- `scripts/step3_motion/s3b_prompt_sweep.py`
- `eval/step3/results/baseline/` (hash-pinned scores after baseline render)
- `eval/step3/results/s3b-p-v1/`, `s3b-p-v2/` after sweep

**Files modified:**
- `config.py` — drop `audio_lufs` key from `FLASHTALK_OPTIONS` + misleading comment (S3-A cleanup)
- `app.py` — remove pre-attenuation block at lines 490-498 (S3-A cleanup)
- `modules/conversation_generator.py` — remove pre-attenuation block at lines 102-110 (S3-A cleanup)
- `.gitignore` — add `uploads/eval-step3/**/*.{mp3,wav,mp4,png}` and `eval/step3/results/*/videos/` and `eval/step3/results/*/blind/`

**Files NOT modified:**
- `/api/generate` — no signature change; existing `prompt` Form field does the job.

**Tests:**
- `tests/test_fixture_yaml_schema.py` — pydantic validation: missing field, wrong type, valid fixture
- `tests/test_run_eval_harness.py` — CLI parse, manifest shape, blind filename generation. HTTP mocked.
- `tests/test_blind_scoring_join.py` — mapping + score join produces correct `(fixture_id, config_id) → score` tuples

No `test_prompt_override_param.py` — there's no new param to test.

**Merge criteria:**
- Typecheck + existing tests pass
- S3-A cleanup doesn't regress existing single-host or conversation render (smoke: one short generation each)
- Baseline scored by jack (`results/baseline/scores.json` populated)
- At least one S3-B variant scored
- Blind-scoring flow exercised end-to-end once

### PR-B (conditional): S3-E POC

Only if PR-A's S3-B winner ≤ baseline. Contents:
- `scripts/step3_motion/s3e_hallo2_poc.py`
- `eval/step3/results/s3e-hallo2-poc/` (results side-by-side, same blind protocol)

Not merged to main — branch or directory, evaluation only. If Hallo2 wins, separate G2-B spec handles actual integration (different architecture entirely).

### Separate small PR on main: integration-plan.md banners

Adds "G2 scope authority: step3-motion-spec.md v3" banner to §6 + §14.1 of `docs/integration-plan.md`. 2 file edits, no code. Trivial review.

---

## 7. Time-box

Week 1:
- Day 1: PR-A scaffolding — S3-A cleanup, fixture pydantic loader, run_eval.py, blind-scoring join, CLI smoke
- Day 2: Operator sources 6 live-commerce clips, extracts MP3, writes metadata. Baseline render + blind scoring (~75 min render, ~10 min scoring)
- Day 3-4: S3-B sweep (3 configs × 75 min = ~4h + ~10 min scoring after blind shuffle)
- Day 5: Decision gate. Commit winner or set up for S3-E Day 6. Verify baseline-sensitivity adjustment if needed.

Week 2 (conditional S3-E, backend offline during this block):
- Day 6: Backend down. Hallo2 checkpoint + deps + fixture-02 smoke.
- Day 7: Extend to 6 fixtures if working. Fallback to EchoMimic if not.
- Day 8: Blind score vs S3-B winner.
- Day 9: Decision. Writeup.
- Day 10: Restart backend. Commit POC scripts (separate branch if Hallo2 not adopted).

Not hitting gate by Day 10 = G2 exits with ceiling diagnosis as the deliverable.

---

## 8. Non-goals

- Frontend changes: none (demo-phase principle per integration-plan §14.2)
- Commercial model integration: deferred
- Multi-product support: deferred (P3 in integration-plan)
- Step 2 composite quality impact on Step 3 motion: accepted noise
- MultiTalk conversation path: untouched beyond the S3-A cleanup
- Fine-tuning FlashTalk: out of scope
- Per-customer reference-frame demo-matching validation: explicit non-goal, runs separately if a winner is identified

---

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| G2-R1 | S3-B prompt lever weak per paper (audio-dominant model) | 3-day S3-E Hallo2 fallback Week 2 |
| G2-R2 | Hallo2 dependency conflicts with SoulX-FlashTalk venv | Separate `venv-hallo2/`, explicit in POC script |
| G2-R3 | GPU OOM on Hallo2 (~20GB VRAM claim) | Backend offline during POC, both GPUs available |
| G2-R4 | Live-commerce MP3 license question | Internal eval only, `.gitignore` excludes audio binaries |
| G2-R5 | 75 min sweep blocks backend for live users | Run sweeps tmux-detached off-hours |
| G2-R6 | Metadata.yaml hand-written → drift | Pydantic validator loud-fails at load |
| G2-R7 | Disk fills (~270MB per cycle × configs) | `prune_results.py`, keep last 3 sweeps + baseline |
| G2-R8 | Operator scoring bias is the real noise source | §3.3 blind + shuffle, cheap mitigation |
| G2-R9 | Demo unavailable during Hallo2 POC days | Accepted — demo-phase not contract-gated |
| G2-R10 | Baseline yes-rate higher than expected → gate unreachable | §4.4 baseline-sensitivity downgrade recorded in manifest |

---

## 10. Exit criteria

G2 primary deliverable is **ceiling diagnosis**: a documented, evidence-backed answer to "can free engineering effort make FlashTalk motion demo-acceptable?"

Primary (always produced):
- Baseline + S3-B sweep manifests with blind-scored rubric data
- Appendix A S3-A math proof (already in spec, terminal)
- §B parent-plan replacement pointers active
- One of: S3-E Hallo2 evidence (if S3-B insufficient) OR concession that no free alternative clears 4/6

Secondary (possible, not required):
- New `FLASHTALK_OPTIONS["default_prompt"]` committed with rubric evidence (if S3-B winner clears gate)
- G2-B follow-up spec for Hallo2 integration (if Hallo2 wins S3-E POC)
- Honest "FlashTalk motion quality is what it is, escalate to commercial model for contract phase"

All three secondary outcomes are valid. The one invalid outcome is "keep trying prompts past Day 5."

---

## Appendix A — S3-A verification log (why dropped)

v1 claimed pre-attenuation (app.py:490-498, `audio × 10^((target_lufs - (-23))/20)`) would shape motion because audio envelope drives FlashTalk's lip motion magnitude.

**Verification** reading `flash_talk/inference.py:49-51`:

```python
def get_audio_embedding(pipeline, audio_array, audio_start_idx=-1, audio_end_idx=-1):
    audio_array = loudness_norm(audio_array, infer_params['sample_rate'])
```

`loudness_norm` at `flash_talk/infinite_talk/utils/multitalk_utils.py:679-685`:

```python
def loudness_norm(audio_array, sr=16000, lufs=-23):
    meter = pyln.Meter(sr)
    loudness = meter.integrated_loudness(audio_array)
    if abs(loudness) > 100:
        return audio_array
    normalized_audio = pyln.normalize.loudness(audio_array, loudness, lufs)
    return normalized_audio
```

`pyln.normalize.loudness(audio, from_lufs, to_lufs)` applies gain of `10^((to - from) / 20)`.

**Compose:**

Let X = original audio's integrated LUFS.
- Pre-attenuate by 10 dB (app.py target_lufs=-33 case): audio' = audio × 10^(-10/20) = audio × 0.316
- Measured loudness of audio' = X - 10
- `loudness_norm(audio')` applies gain 10^((-23 − (X − 10))/20) = 10^((−13 − X)/20)
- Final = audio × 0.316 × 10^((−13 − X)/20) = audio × 10^((−10 − 13 − X)/20) = audio × 10^((−23 − X)/20)

**Identical to `loudness_norm(audio)` without pre-attenuation.** Pre-attenuation exactly canceled.

**Caveat (v3 tightened):** BS.1770 integrated loudness uses a two-stage gating scheme (relative gate at measured loudness minus 10 LU, **plus a fixed absolute gate at -70 LUFS**). Under pre-attenuation, blocks whose unattenuated level sat above -70 LUFS but whose attenuated level drops below the absolute gate get excluded from the second-stage mean, so measured loudness can shift non-linearly in level. For typical broadcast speech this is a sub-1 dB effect — not the ±10 dB sweep v1 promised. Absolute-gate crossing is the only mechanism by which "pre-attenuate + loudness_norm" differs measurably from "loudness_norm alone". It is real but small.

**Conclusion:** S3-A as designed cannot produce the motion-magnitude sweep v1 promised. Dropped from G2. Dead-code path in `app.py:490-498`, `modules/conversation_generator.py:102-110`, `config.py:51-54` removed as part of PR-A (see §6).

---

## Appendix B — Parent-plan replacement statement (v3 rewritten)

This spec is not merely "aligned with" `docs/integration-plan.md` §6 + §14. It is a **replacement** for the G2 scope described there. 2nd Codex review confirmed 7 material contradictions:

| # | integration-plan.md | spec v3 |
|---|---|---|
| 1 | §14.1 "G2 levers = S3-A + S3-B" | S3-A dead, only S3-B active |
| 2 | §6.1 S3-A described as primary lever | dropped with math proof (Appendix A) |
| 3 | §6.timebox "Week 1 audio, Week 2 prompt/S3-E" | Week 1 prompt, Week 2 Hallo2 |
| 4 | §14.4 "track-level eval once" | per-lever-commit eval (baseline + S3-B × 3) |
| 5 | :751 G2 row includes **S3-D CFG sweep** | dropped — paper says no CFG at training time |
| 6 | :789 every S3 change gated via `config.MULTITALK_OPTIONS` booleans | wrong subsystem (MultiTalk vs FlashTalk), no booleans in v3 |
| 7 | :393 S3-E framed commercial/Hedra | Hallo2 open-source only |

**Resolution:** spec v3 is the authoritative G2 execution reference. A separate small PR on main adds pointer banners to `integration-plan.md` §6 + §14.1 so readers of the parent plan land on v3 for G2 details. The parent plan otherwise stays as the broader integration context for G1/G3.

Post-G2, the parent plan can be amended with observed lever effects — but only after real data, not on speculative lever lists.
