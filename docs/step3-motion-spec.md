# G2 step3-motion — Implementation Spec

**Parent plan:** `docs/integration-plan.md` §6 (FlashTalk motion track)
**Branch:** `step3-motion`
**Time-box:** 2 weeks from G2 start (per §6.timebox)
**Status:** spec draft, pending `/plan-eng-review` before implementation

---

## 1. Scope clarification

G2 has **exactly 2 levers** that this spec implements:

- **S3-A** audio pre-attenuation sweep (strong, audio is primary motion driver)
- **S3-B** FlashTalk positive-prompt sweep (weak, text is secondary conditioning)

Everything else on the original §6 lever list was ruled out by paper + code audit (§6.paper):
- No CFG available
- `sample_neg_prompt` is dead code
- `sampling_steps` / `sample_shift` = out-of-distribution if swept
- `ref_target_masks` dead for single-host
- Reference-frame mouth-closure hint: unsound mechanism

**Success criteria (demo-phase):** for ≥5 of the 6-8 fixtures in S3-0, binary
"would I show this video to the customer as demo material?" = yes, measured
against the pre-G2 baseline.

**Failure → S3-E activation.** Hedra POC triggered at end of Week 2 if
S3-A + S3-B combined doesn't clear the bar.

---

## 2. Directory + file layout

```
eval/
  common/                                 ← shared eval machinery
    __init__.py
    fixture.py                            ← fixture load + validation
    rubric.py                             ← score schema + parse/emit
    runner.py                             ← base runner (subprocess
                                             dispatch, manifest write)
    aggregate.py                          ← per-run rollup
  step3/                                  ← motion-specific
    fixtures/
      fixture-01-short-neutral/
        audio.wav                         ← 16kHz mono, ~10s
        reference_frame.png               ← 9:16, 448×768 or 768×1344
        metadata.yaml                     ← see §3.2
        script.txt                        ← source script (optional)
      fixture-02-long-animated/
      ... (6-8 fixtures total, see §3.1)
    results/
      baseline/                           ← jack scores these first
        manifest.json
        scores.json
      s3a-lufs-28/
      s3a-lufs-33/                        ← current default, included for parity
      s3a-lufs-38/
      s3b-prompt-v2/
      ...
    RUBRIC.md                             ← scoring instructions
    run_eval.py                           ← CLI harness (see §4)
    README.md                             ← operator quick-start

scripts/step3_motion/                     ← lever-specific sweep scripts
  s3a_audio_lufs_sweep.py
  s3b_prompt_sweep.py
  s3e_hedra_poc.py                        ← conditional, Week 2 only
```

No changes to `frontend/` — this entire track is backend + eval tooling
(per §14.2 demo-phase principle: no operator-visible UX additions).

---

## 3. S3-0 eval baseline (first work)

### 3.1 Fixture selection

**Audio source (decided 2026-04-25):** extracted from **real live-commerce
videos** as MP3. This matches the B2B customer's actual target scenario
exactly — broadcast-quality professional host audio is what operators
will feed into the pipeline. Extraction via ffmpeg:

```bash
ffmpeg -i <input.mp4> -vn -acodec libmp3lame -q:a 0 -ac 1 -ar 16000 output.mp3
```

Note: 16kHz mono is what Wav2Vec2 expects. Stereo/44.1kHz sources get
downsampled at extract time, not at load time (cleaner split of concerns).

**Reference frame:** ONE fixed image shared across all 6 fixtures. Using
a single face isolates audio as the sole lever (motion variation comes
from audio, not face). Default: `examples/woman.png` or jack's own photo
(operator chooses at fixture-commit time; same choice for all 6).

**Target: 6 fixtures** covering the motion failure modes observed in
broadcast-style delivery. Face constant, audio varies:

| # | Audio profile | Length | Why this fixture |
|---|---|---|---|
| 1 | Calm product intro — opening greeting + brand name | 10s | Baseline "normal" delivery; if this fails, nothing else will pass |
| 2 | Animated product pitch — emphatic delivery | 15s | Over-articulation stress test; loud audio envelope → FlashTalk tends to over-open mouth |
| 3 | Calm explainer — product features walkthrough | 20s | Mid-length natural speech; tests sustained quality across multiple WanModel chunks |
| 4 | Numeric-heavy — price/discount mentions ("1만 2천 원", "30% 할인") | 15s | Tests mixed-language + numeric lip-sync; known FlashTalk weakness |
| 5 | Short salutation / sign-off ("감사합니다, 다음에 또 만나요") | 6s | Tests short-form (under one WanModel chunk); variance isolation |
| 6 | Low-energy conversational aside ("그래서 제가 생각하기에는...") | 12s | Baseline comparison — less audio energy, expected to look best. Identifies whether over-articulation correlates with energy or is constant |

**Source procurement** (operator task, ~20 min):
- Jack picks 6 live-commerce clips from **쿠팡라이브 / 네이버쇼핑라이브 / 카카오쇼핑 /
  유튜브 쇼핑** that exemplify the 6 profiles above
- Extract MP3 per ffmpeg command above
- Store at `eval/step3/fixtures/fixture-{01..06}/audio.mp3`
- Note source URL in metadata.yaml (for future re-baseline, not for
  attribution/upload)

**Copyright stance:** internal evaluation only. Fixture MP3 files
committed to the repo (not uploaded elsewhere, not distributed).
Metadata records the source URL but audio itself never leaves the
codebase. Standard research-eval fair use.

**Fixture freeze rule:** once committed, the fixture set does NOT change
during G2. Adding a fixture invalidates prior scores. If we need to add,
bump to `fixtures-v2/` and re-baseline.

### 3.2 Fixture metadata schema

Each fixture directory has `metadata.yaml`:

```yaml
fixture_id: fixture-01-calm-intro
profile: calm_product_intro
source:
  url: "https://shoppinglive.naver.com/..."   # for re-baseline only, not re-upload
  extracted_at: "2026-04-25T14:00:00+09:00"
audio:
  file: audio.mp3
  duration_sec: 10.4
  sample_rate: 16000
  channels: 1
  peak_db: -2.8           # measured by librosa.load + peak amplitude
  rms_db: -19.2           # measured
reference_frame:
  file: ../fixture-shared/reference.png  # SAME image across all 6 fixtures
  width: 448
  height: 768
transcription:
  text: "안녕하세요 오늘 소개드릴 상품은..."   # optional, operator can skip
  language: ko
notes: "Broadcast-quality audio, calm female host voice, no background music"
```

Rationale for `reference_frame` shared via symlink / relative path: the
face is CONTROL (not variable). Having it in one place prevents accidental
divergence and makes the experimental design explicit.

Helper: `eval/common/fixture.py` loads + validates the yaml, returns a
`Fixture` dataclass. `run_eval.py` iterates via `glob("fixtures/*/metadata.yaml")`.

### 3.3 Rubric schema

`eval/step3/RUBRIC.md` defines what the scorer (jack) evaluates. For
demo-phase (per §14.3 coarsened rubric):

**Binary dimension:**
- `would_show_to_customer`: true/false — "if I had to ship this video as
  demo material to the first customer right now, would I?"

**4 diagnostic dimensions (0-4 scale, for root-cause analysis not gating):**
- `mouth_over_articulation` (0 = natural, 4 = cartoonish wide-open)
- `body_motion_naturalness` (0 = static, 4 = unnatural motion)
- `lip_sync_tightness` (0 = desynced, 4 = perfect sync)
- `identity_preservation` (0 = different person, 4 = identical)

**Score file format** (`results/{run_id}/scores.json`):

```json
{
  "run_id": "s3a-lufs-38",
  "config": {"audio_lufs": -38},
  "commit": "abc1234",
  "timestamp": "2026-04-25T14:30:00+09:00",
  "scorer": "jack",
  "fixtures": {
    "fixture-01-short-neutral": {
      "would_show_to_customer": false,
      "mouth_over_articulation": 3,
      "body_motion_naturalness": 2,
      "lip_sync_tightness": 3,
      "identity_preservation": 4,
      "notes": "Mouth still too wide on 'ㅏ' vowels"
    },
    ...
  },
  "aggregate": {
    "yes_rate": 0.33,
    "mean_over_articulation": 2.8
  }
}
```

`run_eval.py` produces the run dir + manifest; jack fills `would_show_to_customer`
+ 4 diagnostic dims manually by watching each rendered video. `aggregate` is
auto-computed on save.

### 3.4 `run_eval.py` CLI

```
python eval/step3/run_eval.py \
  --config <path-to-override.yaml>  \  # e.g. {audio_lufs: -38}
  --run-id <string>                 \  # used to name results/ subdir
  --fixtures-dir eval/step3/fixtures \
  --output-dir eval/step3/results
```

Behavior:
1. Parse override yaml. Set env vars for subprocess (see §5.1 for
   env-var contract).
2. For each fixture:
   a. Spawn subprocess that runs the existing `/api/generate` pipeline
      against (fixture.reference_frame, fixture.audio).
   b. Wait for completion. Capture output video path.
3. Copy output videos into `results/{run_id}/videos/`.
4. Write `results/{run_id}/manifest.json` with config hash, fixture list,
   video paths, timestamp, commit hash.
5. Open `results/{run_id}/scores.json` as editor-ready skeleton:
   - Pre-filled with fixture IDs and null scores
   - Jack fills in scores while viewing each video

**No direct FlashTalk import.** The harness uses the existing HTTP API
path so we exercise the same code prod uses. Requires backend running on
localhost:8001.

**Wall-clock:** 6 fixtures × ~3 min/render (single worker queue) = **~18 min per run**.

---

## 4. S3-A audio pre-attenuation sweep

### 4.1 Code change — app.py:490 env-var override

Current (app.py:490):
```python
target_lufs = config.FLASHTALK_OPTIONS.get("audio_lufs", -23)
```

New:
```python
# Env override takes precedence so eval/step3/run_eval.py can sweep
# without touching config.py. Fails closed: malformed env → config default.
env_lufs = os.getenv("FLASHTALK_AUDIO_LUFS_OVERRIDE")
if env_lufs is not None:
    try:
        target_lufs = float(env_lufs)
    except ValueError:
        logger.warning(f"FLASHTALK_AUDIO_LUFS_OVERRIDE={env_lufs!r} malformed, falling back")
        target_lufs = config.FLASHTALK_OPTIONS.get("audio_lufs", -23)
else:
    target_lufs = config.FLASHTALK_OPTIONS.get("audio_lufs", -23)
```

Location: single 7-line change at `app.py:490`. No signature changes.
No other files modified for S3-A.

Apply `modules/conversation_generator.py` the same pattern so both paths
stay aligned (found at line 103 per earlier grep).

### 4.2 Sweep values

**3 values, bracketing current -33:**
- `-28` (less attenuation than current — hypothesis: current -33 over-squashes)
- `-33` (current default, serves as in-sweep control)
- `-38` (more attenuation than current — hypothesis: further reduces mouth)

**NOT swept:** `-23` (pipeline default) and anything below `-40`. The former
is the baseline `loudness_norm` already produces; the latter risks audio
being too quiet for the Wav2Vec2 encoder to produce meaningful features.

### 4.3 Sweep script

`scripts/step3_motion/s3a_audio_lufs_sweep.py`:

```python
#!/usr/bin/env python3
"""S3-A audio pre-attenuation sweep.

Runs run_eval.py 3× with FLASHTALK_AUDIO_LUFS_OVERRIDE ∈ {-28, -33, -38}.
Persists results under eval/step3/results/s3a-lufs-*/.
"""
import subprocess, sys
for lufs in (-28, -33, -38):
    run_id = f"s3a-lufs-{abs(lufs)}"
    subprocess.run([
        sys.executable, "eval/step3/run_eval.py",
        "--config", "-",  # read from stdin
        "--run-id", run_id,
    ], input=f"audio_lufs: {lufs}\n", text=True, check=True)
```

Total wall-clock: 3 runs × 18 min = **~54 min** for S3-A.
Scoring: 3 × 6 fixtures = 18 videos × 20s each = **~6 min human time**.

### 4.4 Decision gate (end of S3-A scoring)

Read `results/s3a-lufs-28/scores.json` vs `baseline/scores.json`:
- **delta = max(s3a-lufs-28, s3a-lufs-33, s3a-lufs-38) yes_rate − baseline yes_rate**
- delta ≥ +3 (e.g. baseline 1/6 → best S3-A 4/6) → **commit winning lufs, skip S3-B**
- delta +1 to +2 → **continue to S3-B**
- delta ≤ 0 → **FlashTalk ceiling confirmed, pivot to S3-E**

**Commit the winning value** to `config.FLASHTALK_OPTIONS["audio_lufs"]` via
a separate 1-line PR. Env override stays in place for future sweeps.

---

## 5. S3-B positive-prompt sweep (conditional on Week 1 gate)

### 5.1 Code change — config.py + env override

Current (config.py:37-48):
```python
FLASHTALK_OPTIONS = {
    "default_prompt": (
        "A person is talking with subtle, natural hand gestures and minimal, "
        "stable body movement. The lips move softly and naturally in sync "
        "with speech, not exaggerated. Only the foreground character moves; "
        "the background remains static."
    ),
    # ...
}
```

New: add env override in `app.py:1235` and sibling call sites:
```python
prompt = os.getenv("FLASHTALK_PROMPT_OVERRIDE") or config.FLASHTALK_OPTIONS["default_prompt"]
```

Override at 3 known call sites:
- `app.py:735` (`/api/config` — just for UI display, skip override)
- `app.py:1235` (main `/api/generate`)
- `app.py:1727` (MultiTalk fallback — SKIP, different model)

**No change to generate_conversation_endpoint** (MultiTalk path).

### 5.2 Candidate prompts

Target: **5 candidates** exploring different emphasis patterns.

| ID | Change direction | Text |
|---|---|---|
| p-v0-baseline | Current (control) | *(current default_prompt)* |
| p-v1-subtle-stronger | Stronger restraint verbs | "A person is talking calmly with barely perceptible hand gestures and a still body. The lips move minimally and close fully between words, matching quiet speech. Only the foreground character moves; the background remains static." |
| p-v2-closed-mouth | Explicit closed-mouth hint | "A person speaks with small natural lip movements. The mouth closes completely between syllables. Hands rest at the sides with no gesturing. Body remains relaxed and still. Background is completely stationary." |
| p-v3-korean-context | Korean-style broadcaster framing | "A Korean host speaks in a calm, professional broadcasting voice. Minimal facial animation, subtle lip sync, hands remain at the sides. Professional commerce broadcast style." |
| p-v4-negative-in-positive | Fold "don't" into positive | "A person speaks clearly. Lips open only slightly, never wide. Hands stay at the sides, not gesturing. Body stays still, not swaying. Background is static." |

Rationale: FlashTalk has no negative prompt channel. "Negative" intentions
must be phrased as positive constraints ("closes completely", "stays at
the sides") rather than negation ("no exaggerated opening"). p-v4 is the
explicit test of whether positive-framed negations work as well as direct
positive instructions.

### 5.3 Sweep script

`scripts/step3_motion/s3b_prompt_sweep.py` runs 5 variants × 6 fixtures.

Total wall-clock: 5 × 18 min = **~90 min**. Scoring: 30 videos × 20s ≈ **10 min**.

### 5.4 Decision gate (end of S3-B scoring)

- Winner (best yes-rate) → commit to `config.FLASHTALK_OPTIONS["default_prompt"]`
- If winner ≤ baseline → **S3-B ineffective, pivot to S3-E**
- Combined S3-A + S3-B target: yes_rate ≥ 0.6 across fixtures (4/6+)

---

## 6. S3-E alternative motion model POC (conditional, Week 2 only)

Activated if Week 1 gate says "ceiling confirmed" OR Week 2 S3-B winner
still below bar.

**Budget constraint (decided 2026-04-25):** **zero external cost.**
Commercial models (Hedra/HeyGen/D-ID) ruled out — all are per-API
billing. S3-E candidates are **open-source, GPU-local, free**.

### 6.1 Candidate evaluation order

| Model | Release | Quality signal | License | VRAM | Korean |
|---|---|---|---|---|---|
| **Hallo2** | 2024 Q4 | ★★★★ (strong demos) | Apache 2.0 | ~20GB | language-neutral (audio-driven only) |
| **EchoMimic** | 2024 Q3 | ★★★★ (comparable to Hallo) | Apache 2.0 | ~16GB | language-neutral |
| **MuseTalk** | 2024 | ★★★ (realtime focus) | MIT | ~10GB | language-neutral |
| **SadTalker** | 2023 | ★★ (older, safe fallback) | Apache 2.0 | ~8GB | language-neutral |

Primary candidate: **Hallo2**. Strongest recent quality signal, VRAM
fits current 2× GPU setup. Language-neutral means Korean-specific
training isn't an advantage we'd miss.

### 6.2 POC protocol

`scripts/step3_motion/s3e_hallo2_poc.py`:
1. Clone Hallo2 locally (first-time cost ~1h: checkpoints ~15GB download).
2. Run Hallo2 on **ONE fixture** from S3-0 set (pick fixture-02, the
   animated one — that's where FlashTalk most visibly fails).
3. Output to `eval/step3/results/s3e-hallo2-poc/fixture-02.mp4`.
4. Place side-by-side with our FlashTalk best (same fixture, best S3-A+B
   config).
5. Jack watches both, binary verdict: "alternative better enough to
   justify swap?"

**Time-budget:** 2 days including checkpoint download + first-run debug.
If Hallo2 setup fails (dependency hell, GPU OOM, etc.) within day 1,
fall back to EchoMimic (simpler).

### 6.3 Dropped (commercial models)

Hedra / HeyGen / D-ID remain as reference but NOT in this track's scope
due to the no-external-cost constraint. If post-contract the customer
indicates budget, revisit separately. Not a §13 non-goal — just
deferred until there's a budget line item.

### 6.4 If S3-E wins

Separate G2-B PR swaps FlashTalk inference for the winning open-source
model at the app.py call site. Architecture impact: potentially much
larger than expected (different API, different dependency tree,
different preprocessing). Out of scope for this spec; G2-B gets its
own spec.

---

## 7. Per-PR breakdown

### PR-A: S3-0 + S3-A (Week 1)

Lands together because S3-A depends on eval infrastructure.

**Files added:**
- `eval/common/{__init__,fixture,rubric,runner,aggregate}.py`
- `eval/step3/fixtures/fixture-{01..06}/{audio.wav,reference_frame.png,metadata.yaml,script.txt}`
- `eval/step3/RUBRIC.md`
- `eval/step3/run_eval.py`
- `eval/step3/README.md`
- `scripts/step3_motion/s3a_audio_lufs_sweep.py`
- `eval/step3/results/baseline/{manifest.json,scores.json}` (hash-pinned baseline)

**Files modified:**
- `app.py` (+7 lines at line 490 for env override)
- `modules/conversation_generator.py` (+7 lines at line 103 for parity)
- `.gitignore` (+2 lines for `eval/step3/results/*/videos/` — keep JSON scores in git, video binaries out)

**Tests added:**
- `tests/test_audio_lufs_env_override.py` (3 cases: unset → config, valid float → used, malformed → falls back + warns)

**Merge criteria:**
- Typecheck + lint + existing tests pass
- Baseline scored (`results/baseline/scores.json` populated)
- At least one S3-A sweep run scored
- Env override test passes

### PR-B: S3-B (conditional, Week 2)

Only if Week 1 gate = +1 to +2 rubric delta.

**Files added:**
- `scripts/step3_motion/s3b_prompt_sweep.py`

**Files modified:**
- `app.py` (+1 line for prompt env override at call sites)
- `config.py` (+1 line when committing winner — SEPARATE commit after sweep)

**Merge criteria:** winner prompt identified + committed.

### PR-C: S3-E POC (conditional, Week 2)

Only if Week 1 gate = ceiling OR Week 2 S3-B shows no win.

**Files added:**
- `scripts/step3_motion/s3e_hedra_poc.py`
- `eval/step3/results/s3e-hedra-poc/`

Not landed as prod code — this is evaluation scaffolding. If commercial
swap decided, a separate G2-B spec covers the actual integration.

---

## 8. Dependencies

**Existing in project (verified):**
- `librosa` (app.py:482) — audio I/O for pre-attenuation
- `loudness_norm` (flash_talk/infinite_talk/utils/multitalk_utils.py) — LUFS normalization
- FastAPI backend running on `:8001` for the eval harness to hit

**New dependencies (for this spec):**
- None for S3-A, S3-B, S3-0 — pure YAML + stdlib + existing project deps
- S3-E Hedra POC: `requests` (probably already installed for HTTP) + HEDRA_API_KEY env var

**No MediaPipe, no OpenCV, no new ML libs.** Demo-phase scope stays lean.

---

## 9. Operator workflow (jack's actual day-to-day)

### First time setup (one-time, ~45 min)
1. Pull branch, install deps
2. Start backend: `CUDA_VISIBLE_DEVICES=1,3 uvicorn app:app --host 0.0.0.0 --port 8001`
3. **Source 6 live-commerce video clips** from 쿠팡라이브 / 네이버쇼핑라이브 etc.
   matching the 6 profile slots in §3.1 (calm intro, animated pitch, etc.).
   Save source URLs for later reference.
4. **Extract MP3 from each:**
   ```bash
   for i in 01 02 03 04 05 06; do
     mkdir -p eval/step3/fixtures/fixture-${i}-*
     ffmpeg -i /path/to/clip-${i}.mp4 -vn -acodec libmp3lame \
            -q:a 0 -ac 1 -ar 16000 \
            -ss <start_s> -to <end_s> \
            eval/step3/fixtures/fixture-${i}-*/audio.mp3
   done
   ```
5. Pick ONE reference frame image, place at `eval/step3/fixtures/fixture-shared/reference.png`
6. Write `metadata.yaml` for each fixture (template at `eval/step3/fixtures/_TEMPLATE.yaml`)
7. Run baseline: `python eval/step3/run_eval.py --config /dev/null --run-id baseline`
8. Watch 6 generated videos, score them in `results/baseline/scores.json` (20 min)
9. Commit fixture MP3s + metadata + baseline scores

### Each lever sweep (~30-60 min)
1. Run sweep: `python scripts/step3_motion/s3a_audio_lufs_sweep.py`
2. Script runs 3× 18 min = 54 min background (cron-able, not blocking)
3. When done, `run_eval.py` has opened 3 scores.json skeletons
4. Watch 18 videos, score binary + diagnostic dims (10 min)
5. Commit scores
6. Check `aggregate.yes_rate` delta, act per §4.4 gate

### Week 2 conditional
Based on Week 1 gate, either `s3b_prompt_sweep.py` or `s3e_hedra_poc.py`.

---

## 10. What this spec deliberately does NOT cover

- **Frontend changes:** none. Demo-phase principle per `integration-plan.md §14.2`.
- **Multi-tenancy, user scoping:** none. All backend env vars are process-global.
- **CI gating on rubric deltas:** none. Scoring stays human. CI can only check file-presence (per §10 of parent plan).
- **Fine-tuning FlashTalk:** out of scope. Spec explores only inference-time levers.
- **Step 2 composite quality impact on Step 3 motion:** accepted as background noise. §6.3 reference-frame preprocessing dropped.
- **MultiTalk (conversation) path:** untouched. Single-host is the demo focus.
- **Long-form generation (>1 chunk):** fixtures stay single-chunk length (<60s). Long-form drift is measured as a failure mode but not solved in G2.

---

## 11. Risk register (G2-specific)

| # | Risk | Mitigation |
|---|---|---|
| G2-R1 | S3-A sweep bracket (-28, -33, -38) doesn't bracket the true optimum | Extend to {-23, -28, -33, -38, -43} in a second sweep if Week 1 result shows monotonic trend toward an edge |
| G2-R2 | Baseline scoring is noisy (jack's mood varies) | Score all variants in one sitting, randomized order, no prior info on which is which |
| G2-R3 | Reference frame variance | Pinned: fixture metadata.yaml records frame source. Same frame reused across all runs. |
| G2-R4 | Backend single-worker queue blocks other work during sweep | Run sweeps at off-hours or accept 30-60 min blocking |
| G2-R5 | Disk fills with result videos | `.gitignore` excludes `results/*/videos/`. Periodic cleanup of old run dirs. |
| G2-R6 | Env-var pattern is obscure/easy to forget | `run_eval.py` logs the resolved values at startup; README.md documents |

---

## 12. Open questions — resolved 2026-04-25

1. ✅ **Fixture audio source:** extracted MP3 from real live-commerce
   videos (쿠팡라이브 etc.). Broadcast-quality professional audio.
   Resolution reflected in §3.1 + §9.
2. ✅ **Scoring UI:** plain JSON editing in editor. No custom tool.
   Decided unilaterally — lowest friction, ships today.
3. ✅ **S3-E budget:** zero external cost. Rules out all commercial
   models. S3-E re-scoped to open-source alternatives (Hallo2 primary).
   Resolution in §6.
4. ✅ **"80% 영상 문제" decomposition:** motion-dominant, but TTS has
   its own specific sub-issue — **voice clone from extracted audio**
   is inconsistent. **ElevenLabs TTS itself is fine.** G3 TTS track
   scope shifts accordingly (V-A script preproc drops or deprioritizes,
   V-B clone quality + V-D multi-gen move up). Does not affect G2; noted
   here for G3 spec author.

All resolved. No blocker for starting implementation.

---

## 13. Exit criteria

End of Week 2:
- EITHER: new `audio_lufs` value + new `default_prompt` committed to `config.py`, with evidence (rubric scores) showing demo-phase yes-rate improved
- OR: S3-E POC evidence showing commercial model clears the bar, with concrete recommendation for G2-B scope
- NOT acceptable: "let's try a few more prompts" — time-box forces a decision

After G2 closes, planning G3 (TTS track) or G1 (step2-trim) picks up the
80%-pain work that remains.
