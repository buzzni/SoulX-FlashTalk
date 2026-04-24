# G2 step3-motion — Implementation Spec (v2, post-Codex-review)

**Parent plan:** `docs/integration-plan.md` §6 (FlashTalk motion track)
**Branch:** `step3-motion`
**Time-box:** 2 weeks from G2 start
**Status:** v2 — **rewritten after Codex review identified 2 fatal spec errors in v1**. See §A (Appendix) for the verification log.

---

## 0. What changed from spec v1

v1 had 6 Codex-flagged issues, 2 fatal:

1. **S3-A audio pre-attenuation is a mathematically dead lever.** `flash_talk/inference.py:50` calls `loudness_norm` after app.py's pre-attenuation. `loudness_norm` measures the attenuated signal's LUFS and normalizes back to -23, exactly undoing the pre-attenuation (see §A for the proof). All 3 sweep values (-28/-33/-38) produce mathematically identical signals at the Wav2Vec2 input. **S3-A dropped entirely.**

2. **env-var override architecture doesn't work.** v1 wanted the eval harness to set `FLASHTALK_AUDIO_LUFS_OVERRIDE` and hit `/api/generate` over HTTP. But `/api/generate` runs inside a long-lived uvicorn process that read env at startup — a client-subprocess env mutation never reaches the server. **Replaced with request-body override param per call.**

Plus 4 non-fatal:
3. Fixture paths under `eval/step3/fixtures/` would be rejected by `safe_upload_path` (only UPLOADS_DIR/OUTPUTS_DIR/EXAMPLES_DIR allowed). → fixtures move under UPLOADS_DIR.
4. Time estimate was 18 min/run; real is **60-110 min/run** per `app.py:525` comment (60-90s per chunk × ~8 chunks per 10s audio). v2 time-box recalibrated.
5. v1 contradicted parent plan's per-lever gating. v2 aligns.
6. S3-E section mixed Hallo2 prose with Hedra filenames. Fully swept.

**Net effect on G2 scope:** S3-A dead, S3-B remains (paper suggests small effect). G2 collapses to **1 week S3-B sweep + ~1 week S3-E Hallo2 POC** rather than 2 week audio+prompt sweep.

---

## 1. Revised scope

G2 has **1 in-scope lever** and **1 contingency path**:

- **S3-B** FlashTalk positive-prompt sweep (likely modest effect per paper)
- **S3-E** Hallo2 open-source model POC (likely primary path given S3-A dead + S3-B weak)

Dropped: S3-A, sample_neg_prompt, CFG sweep, sampling_steps sweep, sample_shift sweep, reference-frame preprocessing, commercial model POC.

**Success criteria (demo-phase):** for ≥4 of the 6 fixtures, rubric "would I show this video to customer?" = yes after the winning change. Baseline today likely scores ≤2/6. Target delta ≥ +2.

**Failure → accept FlashTalk ceiling.** If neither S3-B nor Hallo2 reaches 4/6, the motion problem is downstream of G2 engineering reach. Pivot to commercial model (outside G2 budget) or accept current quality for demo.

---

## 2. Architecture

### 2.1 Why request-body override, not env var (Codex #1 fix)

v1 error: env vars set by a subprocess don't reach a running uvicorn. v2 fix: add an explicit per-request override parameter.

`/api/generate` gains:
```python
prompt_override: Optional[str] = Form(None)
```

Single change at `app.py:1233` area:
```python
if prompt_override is not None and prompt_override.strip():
    prompt = prompt_override
elif not prompt:
    prompt = config.FLASHTALK_OPTIONS["default_prompt"]
```

Harness passes `prompt_override` in the POST form body, per-request. No global mutation, no race. `/api/config` endpoint unaffected.

**No env vars in this spec.** This was the single biggest v1 design mistake.

### 2.2 Why fixtures live under UPLOADS_DIR (Codex #3 fix)

`safe_upload_path` (`utils/security.py`) enforces all host/audio paths resolve to `UPLOADS_DIR`, `OUTPUTS_DIR`, or `EXAMPLES_DIR`. Paths outside silently fall back to defaults (`app.py:1168-1177`), which would produce silent garbage eval runs.

Fixture layout:
```
uploads/                               ← existing, already in SAFE_ROOTS
  eval-step3/
    fixtures/
      fixture-01-calm-intro/
        audio.mp3
      fixture-02-animated-pitch/
        audio.mp3
      ...
      fixture-shared/
        reference.png
```

Rationale: `uploads/` is already validated as a safe root. Sub-directory doesn't affect validation. No config change.

`metadata.yaml` + scoring artifacts stay in the repo tree (`eval/step3/fixtures-meta/`). Audio/image binaries live under `uploads/eval-step3/` which is gitignored.

### 2.3 Eval harness as polling HTTP client (Codex #1 continued)

`/api/generate` returns `{task_id, message, queue_position}` — not a video path. Eval harness must:

```
1. POST /api/generate  →  task_id
2. Poll  /api/tasks/{task_id}/state   until status ∈ {completed, error, cancelled}
3. GET   /api/results/{task_id}       →  video URL
4. Download video locally for operator scoring
```

This matches production flow exactly. Wait-time during poll = one video's inference time.

---

## 3. S3-0 eval baseline

### 3.1 Fixture set

**6 fixtures** extracted from real live-commerce videos as MP3. ffmpeg command per spec v1 §9. Profile guide (substitute freely if live-commerce clusters differently):

| # | Audio profile | Length | Failure mode targeted |
|---|---|---|---|
| 1 | Calm product intro | 10s | Baseline "normal" — if this fails everything fails |
| 2 | Animated product pitch | 15s | Over-articulation stress |
| 3 | Calm explainer | 20s | Sustained quality across multiple chunks |
| 4 | Numeric-heavy pricing | 15s | Mixed-language + numeric lip-sync |
| 5 | Short salutation | 6s | Sub-chunk length variance |
| 6 | Low-energy aside | 12s | Baseline comparison (audio energy ≠ over-articulation) |

Fixed reference frame across all 6 fixtures — identity is control, audio is variable.

### 3.2 Metadata schema (pydantic-validated)

`eval/step3/fixtures-meta/fixture-01-calm-intro.yaml`:

```yaml
fixture_id: fixture-01-calm-intro
profile: calm_product_intro
source:
  url: "https://shoppinglive.naver.com/..."
  extracted_at: "2026-04-25T14:00:00+09:00"
audio:
  file: uploads/eval-step3/fixtures/fixture-01-calm-intro/audio.mp3  # path under SAFE_ROOTS
  duration_sec: 10.4
  sample_rate: 16000
reference_frame:
  file: uploads/eval-step3/fixtures/fixture-shared/reference.png
notes: "Broadcast-quality audio, calm female host voice"
```

`eval/step3/fixture.py` loads + validates via `pydantic.BaseModel`. Missing required field / wrong type → hard fail at load.

### 3.3 Rubric

Binary gate dimension (per `integration-plan.md §14.3`):
- `would_show_to_customer`: true/false

Diagnostic dimensions (0-4, for root-cause not gating):
- `mouth_over_articulation`, `body_motion_naturalness`, `lip_sync_tightness`, `identity_preservation`

Score file format unchanged from v1 §3.3.

### 3.4 `run_eval.py` (HTTP polling client)

```
python eval/step3/run_eval.py \
  --config <yaml-or-stdin>      \  # e.g. "prompt_override: '...text...'"
  --run-id <string>             \
  --fixtures-meta-dir eval/step3/fixtures-meta \
  --output-dir eval/step3/results \
  --backend http://localhost:8001
```

For each fixture:
1. POST `/api/generate` with form fields: `host_image_path`, `audio_source=upload`, `audio_path`, `prompt_override` (from config).
2. Poll `/api/tasks/{task_id}/state` every 5s until terminal.
3. On completed, GET `/api/results/{task_id}`.
4. Download MP4, copy to `results/{run_id}/videos/`.
5. Append fixture → scores skeleton entry.

**Expected wall-clock per fixture** (corrected from v1):
- 10s audio × 3 chunks × ~75s/chunk = **~225s = ~4 min** (not 3 min as v1 claimed)
- Longer fixtures proportionally more

Full run (6 fixtures of varying length, total ~78s audio, ~60 chunks):
- 60 chunks × 75s = **~75 min wall-clock** per sweep config
- Serial (single worker)

---

## 4. S3-B positive-prompt sweep

Only active G2 lever (v2).

### 4.1 Code change

Single addition to `app.py:1136` (endpoint signature):
```python
prompt_override: Optional[str] = Form(None)
```

And at `app.py:1233`:
```python
# Accept caller override (eval harness uses this). None → config default.
if prompt_override is not None and prompt_override.strip():
    prompt = prompt_override
```

3 lines. No env vars. No new module. No `modules/env_override.py`.

`modules/conversation_generator.py` path NOT updated (MultiTalk conversation — out of G2 scope).

### 4.2 Candidate prompts — reduced to 3

v1 had 5 including speculative Korean-context. v2 reduces to 3 to fit time budget:

| ID | Change direction | Text |
|---|---|---|
| p-v0 | Current (control) | *(current `FLASHTALK_OPTIONS["default_prompt"]`)* |
| p-v1 | Closed-mouth emphasis | "A person speaks with small natural lip movements. The mouth closes completely between syllables. Hands rest at the sides with no gesturing. Body remains relaxed and still. Background is completely stationary." |
| p-v2 | Negation-as-positive | "A person speaks clearly. Lips open only slightly, never wide. Hands stay at the sides, not gesturing. Body stays still, not swaying. Background is static." |

Dropped from v1: p-v1-subtle-stronger (redundant with p-v1), p-v3-korean-context (speculative without basis), p-v4-negative-in-positive (same intent as p-v2).

### 4.3 Sweep execution

`scripts/step3_motion/s3b_prompt_sweep.py`:
- 3 configs × 6 fixtures
- Per-sweep-config wall-clock: ~75 min
- Total: **~225 min = 3h 45m**
- Scoring: 18 videos × ~30s each = ~10 min human

### 4.4 Decision gate (end of S3-B scoring)

- Winner's yes-rate ≥ 4/6 AND ≥ baseline + 2 → **commit winning prompt to config, G2 success**
- Winner's yes-rate = baseline (no change) → **FlashTalk prompt lever confirmed weak, pivot to S3-E Hallo2**
- Winner's yes-rate < baseline → rare; indicates prompt change is harmful. Revert to default, pivot to S3-E.

---

## 5. S3-E Hallo2 POC (now ~Week 1.5+)

Given S3-A dropped and S3-B effect expected modest, **S3-E becomes the likely primary deliverable of G2**.

### 5.1 Why Hallo2

| Candidate | Release | VRAM | License | Why |
|---|---|---|---|---|
| **Hallo2** | 2024 Q4 | ~20GB | Apache 2.0 | Strongest recent quality signal, audio-driven, fits GPU |
| EchoMimic | 2024 Q3 | ~16GB | Apache 2.0 | Fallback if Hallo2 setup fails |
| MuseTalk | 2024 | ~10GB | MIT | Realtime focus, lower quality ceiling |

### 5.2 POC protocol

`scripts/step3_motion/s3e_hallo2_poc.py`:

Day 1:
1. Clone Hallo2 repo, download checkpoints (~15GB, 1-2h on decent bandwidth)
2. Resolve Python deps (likely conflicts with SoulX-FlashTalk venv — **use separate venv**)
3. Run Hallo2 inference on 1 fixture (fixture-02, the animated one — most likely to show delta)

Day 2:
4. Extend to all 6 fixtures if Day 1 works
5. Score vs FlashTalk winning S3-B output
6. Decision: commit to Hallo2 swap? → Follow-up G2-B spec

Realistic Day 1 risk: dependency hell OR GPU OOM. Fallback plan:
- If Hallo2 fails Day 1 by noon → try EchoMimic same day
- If both fail by end Day 1 → concede motion ceiling, report to user

**Time-box:** 3 days hard cap. If no working alternative by Day 3, G2 exits with "FlashTalk ceiling, no free alternative clears the bar" conclusion.

---

## 6. Per-PR breakdown (revised)

### PR-A: S3-0 + S3-B combined

Lands everything needed to run the sweep and commit a winner.

**Files added:**
- `uploads/eval-step3/fixtures/fixture-{01..06}-*/audio.mp3`  (actual audio files, gitignored if large)
- `uploads/eval-step3/fixtures/fixture-shared/reference.png`
- `eval/step3/fixtures-meta/fixture-{01..06}.yaml` (metadata, in git)
- `eval/step3/fixture.py` (pydantic loader)
- `eval/step3/rubric.py` (score schema + I/O)
- `eval/step3/run_eval.py` (HTTP polling client)
- `eval/step3/RUBRIC.md`
- `eval/step3/README.md`
- `scripts/step3_motion/s3b_prompt_sweep.py`
- `eval/step3/results/baseline/` (hash-pinned scores)
- `eval/step3/results/s3b-p-v1/`, `s3b-p-v2/` after sweep

**Files modified:**
- `app.py` (+4 lines at line 1136, +3 at 1233 for `prompt_override` param)
- `.gitignore` (+2 lines for `uploads/eval-step3/**/*.{mp3,wav,mp4,png}` and `eval/step3/results/*/videos/`)

**Tests:**
- `tests/test_prompt_override_param.py` — 3 cases: unset (config default), set (override wins), empty string (config default)
- `tests/test_fixture_yaml_schema.py` — pydantic validation: missing required field, wrong type, valid fixture
- `tests/test_run_eval_harness.py` — CLI parse, manifest shape. Subprocess/HTTP mocked.

**Merge criteria:**
- Typecheck + existing tests pass
- Baseline scored by jack (`results/baseline/scores.json` populated)
- At least one S3-B variant scored
- Regression guard: calling `/api/generate` with no `prompt_override` produces identical result to current main (pre-change)

### PR-B (conditional): S3-E POC

Only if PR-A's S3-B winner ≤ baseline. Contents:
- `scripts/step3_motion/s3e_hallo2_poc.py`
- `eval/step3/results/s3e-hallo2-poc/` (results side-by-side)

Not merged to main — kept as branch or directory, evaluation only. If Hallo2 wins, separate G2-B spec handles actual integration (different code architecture entirely, out of G2 time-box).

---

## 7. Time-box (revised, realistic)

Week 1:
- Day 1: PR-A scaffolding — add prompt_override param, fixture pydantic loader, run_eval.py, CLI smoke
- Day 2: Operator sources 6 live-commerce clips, extracts MP3, writes metadata. Baseline render + scoring (~75 min render, ~10 min scoring)
- Day 3-4: S3-B sweep (3 configs × 75 min = ~4h wall-clock + ~10 min scoring)
- Day 5: Decision gate. Commit winner or set up for S3-E Day 6

Week 2 (conditional S3-E):
- Day 6-7: Hallo2 checkpoint + dep + first fixture
- Day 8: Extend to all 6 if working
- Day 9: Compare vs FlashTalk winner, decision
- Day 10: Writeup + commit POC scripts (main or separate branch)

**Not hitting gate by Day 10 = G2 exits.** Pivot to commercial model planning (outside G2) or accept FlashTalk demo quality.

---

## 8. Non-goals (carried from v1)

- Frontend changes: none
- Commercial model integration: deferred
- Multi-product support: deferred (P3 in integration-plan)
- Step 2 composite quality impact on Step 3 motion: accepted noise
- MultiTalk conversation path: untouched
- Fine-tuning FlashTalk: out of scope

---

## 9. Risks (revised)

| # | Risk | Mitigation |
|---|---|---|
| G2-R1 | **S3-B prompt lever also weak** (paper suggests audio-dominant model) | 3-day S3-E Hallo2 fallback in Week 2 |
| G2-R2 | Hallo2 dependency conflicts with SoulX-FlashTalk venv | Separate venv `venv-hallo2/`, explicit in POC script |
| G2-R3 | GPU OOM on Hallo2 (~20GB VRAM claim may lowball) | 1-GPU `CUDA_VISIBLE_DEVICES=3` isolated run, reduced batch if needed |
| G2-R4 | Live-commerce MP3 license question | Internal eval only, `.gitignore` excludes audio binaries from repo |
| G2-R5 | 75 min sweep blocks backend | `tmux` detach, schedule off-hours |
| G2-R6 | Metadata.yaml hand-written → drift across 6 fixtures | Pydantic validator loud-fails at load |
| G2-R7 | Disk fills (~270MB per cycle) | `prune_results.py`, keep last 3 sweeps + baseline |
| G2-R8 | Reviewer fatigue biases scoring | Score all configs back-to-back, shuffle order, no prior info on which is which |

---

## 10. Exit criteria

End of Week 2:
- EITHER new `FLASHTALK_OPTIONS["default_prompt"]` committed with rubric evidence
- OR Hallo2 POC evidence + G2-B scope document for follow-up
- OR honest "FlashTalk motion quality is what it is, no free lever clears the demo bar, escalate to commercial model for contract phase"

All three are valid outcomes. The one **invalid** outcome is "keep trying prompts past Day 5."

---

## Appendix A — S3-A verification log (why dropped)

v1 claimed pre-attenuation of audio (app.py:490-498, `audio × 10^((target_lufs - (-23))/20)`) would shape motion because audio envelope drives FlashTalk's lip motion magnitude.

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

Let X = original audio's LUFS.
- Pre-attenuate by 10 dB (app.py target_lufs=-33 case): audio' = audio × 10^(-10/20) = audio × 0.316
- Measured loudness of audio' = X - 10
- `loudness_norm(audio')` applies gain 10^((-23 - (X-10))/20) = 10^((-13-X)/20)
- Final = audio × 0.316 × 10^((-13-X)/20) = audio × 10^((-10-13-X)/20) = audio × 10^((-23-X)/20)

**Identical to `loudness_norm(audio)` without pre-attenuation.** Pre-attenuation exactly canceled.

Caveat: `pyln.Meter.integrated_loudness` uses a gated measurement (ITU-R BS.1770) that's not a perfect linear function of input level — gating thresholds can change when signal magnitude changes. Real-world residual between "attenuated then normalized" and "just normalized" is typically <1 dB. Not nothing, but not the ±10 dB range v1 claimed to be sweeping.

**Conclusion:** S3-A as designed cannot produce the motion-magnitude sweep v1 promised. Dropped from G2.

---

## Appendix B — Parent plan sync statement

This spec modifies the G2 execution described in `docs/integration-plan.md`:

- Plan §14.1 lists G2 levers as "S3-A + S3-B". **v2 spec:** S3-A dead, only S3-B active.
- Plan §6.1 describes S3-A as primary lever. **v2 spec:** dropped with verification log (Appendix A).
- Plan §6.timebox 2-week split (Week 1 audio, Week 2 prompt/S3-E). **v2 spec:** Week 1 prompt, Week 2 Hallo2 or exit.
- Plan §14.4 says track-level eval once. **v2 spec:** per-lever-commit eval (S3-B × 3 variants) because the lever space collapsed to one dimension.

Rather than editing the integration plan, v2 spec is the authoritative G2 execution reference. Integration plan will be amended post-G2 with actual observed lever effects.
