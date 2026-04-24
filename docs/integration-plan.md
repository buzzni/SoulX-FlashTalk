# Integration Plan — `refactor-plan` ⊕ `step2-rebuild` ⊕ Step 3 Naturalness Track

**Status:** draft, pending `/plan-eng-review`
**Current branch:** `refactor-plan` (PR #1, 22 commits, CI green)
**Sibling branch:** `step2-prompt-rebuild` (20 commits, unmerged)
**Scope:** decide how the two branches + a newly-surfaced Step 3 naturalness track fit together without one killing the other.

---

## 1. Context

**First customer: B2B live-commerce video production company.**
Operators produce live-commerce style host videos from (a) the producer's own photo (face), (b) their own voice recording, (c) products, (d) a background. The app assembles host → composite → voice → talking-head video.

Volume estimate:
- Per-operator day: tens to hundreds of videos
- Step 2 calls per video: 1–3 (iteration rate)
- Hourly Pro-tier eligibility firings: realistic at 10s/hour per operator, hundreds/hour company-wide

Real pain points (stated by user, ordered by severity):
- **P1.** Step 3 video output — lip movement is exaggerated, hand/body gestures look unnatural. **User perceives this.** Asks "can we fix via prompt?"
- **P2.** Step 2 composite — "sticker effect" products, duplicate background objects, ignored spatial directions. Quality bugs B1/B2/B3 in `step2-rebuild` plan.
- **P3.** Multi-product support (currently 1). Wanted soon.

Two branches grew in parallel. Neither knew about the other. They overlap on 5 files. One file (`frontend/src/studio/Step2Composite.jsx`) is modify-in-one, delete-in-the-other.

---

## 2. Key decisions (locking in rationale)

### 2.1 Merge order: **refactor-plan first, step2-rebuild rebased on top**

- refactor-plan is a structural change (22 commits, +19860/-4509). Rebasing step2-rebuild's 20 commits on top costs ~4-8 hours of conflict work. The reverse (refactor-plan rebased on step2-rebuild) would cost days — every decomposition touches files that step2-rebuild also touches, and the rebase would multiply 20 conflict resolutions by ~100 files instead of the handful that actually overlap.
- refactor-plan is already PR #1, CI green, browse-smoked. It's the stable base.

### 2.2 step2-rebuild: scope-trimmed via **Option C++** (not merged as-is)

Analysis justifying this decision is in a separate artifact; summary:
- Gemini 3 Flash/Pro are multimodal edit models with single-pass multi-image composition as the blessed path (per Google's own prompting guide). 2-pass is a diffusion-era workaround that can actively hurt Gemini 3's scene/lighting planning.
- Real quality wins (B1/B2/B3) live in the prompt rewrite, not the surrounding infrastructure.
- Full infrastructure (policy resolver, rate limiter, cost tracker, judge, bakeoff) is justified at B2B volume **but belongs in an operator admin panel, not end-user UI**.
- End-user UI gets ONE UX win from the rebuild: the judge's "★ AI 추천" crown, because operators at volume have genuine decision fatigue on 4-candidate selection. Everything else is operator-facing.

### 2.3 Step 3 naturalness is a **separate track**, not blocked by step2-trim

Prompt-level tuning on `FLASHTALK_OPTIONS.default_prompt` + FlashTalk
pipeline sample_neg_prompt + audio_lufs sweep doesn't require step2-trim
to land. It can run in parallel. §8 sequence reflects this: Step 3 PRs
depend only on refactor-plan (PR #1) + persona validation, not on
step2-trim.

(Earlier draft had Step 3 PRs chained after step2-trim — fixed per
Codex finding #2.)

---

## 3. Detailed scope for scope-trimmed step2-rebuild (Option C++)

### 3.1 Keep (value is real)

**Backend:**
- `modules/prompts/step2_v1.yaml` — 5-block prompt structure. Core quality delivery for B1/B2/B3.
- `modules/step2/prompt_builder.py` — assembles ScenePrompt from input.
- `modules/step2/sanitize.py` — prompt injection defense. Non-optional for any v1 prompt.
- `modules/step2/spatial_keywords.py` — detects "우측/좌측/상단/하단" for logging/routing.
- `modules/step2/judge.py` — but **repositioned as UX helper** (decision-fatigue reducer), not quality gate. Returns `winner` and `order` for crown rendering.
- `modules/step2/policy.py` — backend-only. No end-user exposure.
- `modules/step2/rate_limit.py` — backend hard cap, not hourly budget reporter. Simpler.
- `modules/step2/cost.py` — backend logging/metrics only, no UI preview.
- `scripts/step2_bakeoff/` — move here from `modules/step2/bakeoff*` if currently coupled. Dev-only tool.
- `tests/test_step2_*` — 9 new test files, mostly keep. Trim `test_two_pass_*` (removed below).

**Frontend (after remapping — see §4):**
- Judge winner crown + "★ AI 추천" ribbon on the recommended variant.
- Simple "고품질 모드" → "Pro 모드" toggle (one boolean) exposed to operators. Default off.

### 3.2 Remove

**Backend:**
- `_run_two_pass()` and the entire 2-pass orchestration path in `modules/step2/orchestrator.py`. Keep single-pass only.
- The `two_pass` flag plumbing in `modules/step2/policy.py`. Always false.
- `_TWO_PASS_IMPLEMENTED` global and surrounding guards.
- Cost estimates for 2-pass (since it doesn't run).

**Frontend:**
- 4-mode selector UI (`legacy/v1_safe/v1_full/v1_experimental` dropdown).
- `forceFlash` checkbox.
- Cost preview badge (`$0.XX`).
- Pass progress caption ("1/2 · 배경 먼저 그리는 중").
- Rate-limit exceeded warning banner (keep the backend enforcement but don't render the banner — operators don't trigger it at realistic cadence).

### 3.3 Remap into refactor-plan's decomposed structure

refactor-plan's `frontend/src/studio/step2/` layout:
- `Step2Composite.tsx` (container, 285 LOC)
- `ProductList.tsx`
- `BackgroundPicker.tsx`
- `CompositionControls.tsx`
- `CompositionVariants.tsx`

step2-rebuild's additions map as follows:

| step2-rebuild addition | New home | Notes |
|---|---|---|
| `streamState` hook (judge + tier + rate-limit) | `step2/Step2Composite.tsx` container | Shrink: drop `pass`, `judgeFailed`, `estimatedCost`, `proTriggerReason`, `rateLimitHit` fields. Keep `judgeRequested`, `judgeExecuted`, `judgeWinner`, `judgeRank`, `judgeWinnerReason`, `tier`. |
| `ranked` event handler | `Step2Composite.tsx` container | Unchanged semantics. |
| `init` event tier/cost capture | `Step2Composite.tsx` container | Strip cost fields. |
| `done.judge_executed/failed` capture | `Step2Composite.tsx` container | Keep. |
| Advanced settings `<details>` with mode selector | **Removed** | Operator admin panel later. |
| Pro-auto badge | Simplified: **"Pro 모드 적용 중"** shown during generation if `composition.proMode === true`. No cost, no trigger reason. | `CompositionControls.tsx` |
| Rate-limit warning banner | **Removed from UI.** Backend still enforces. | — |
| Judge winner crown | `CompositionVariants.tsx` | Matches decomposed variant-grid surface. Pure UI prop from container. |
| Progress subtitle with pass caption | **Removed.** Card subtitle stays generic. | — |
| `buildCompositeBody(step2Mode, forceFlash)` | `src/api/composite.ts` | step2Mode always `"v1"` in prod (no UI toggle). forceFlash plumbing removed; Pro toggle maps to a different field (`proMode`). |

---

## 4. New end-user UI surface (final shape)

What the operator sees on Step 2 after this lands:

1. Same wizard Step 2 screen as refactor-plan (ProductList + BackgroundPicker + CompositionControls).
2. One new control in CompositionControls: **"고품질 모드"** toggle (default off). Copy: "더 자연스러운 합성을 원하면 켜세요. 느려지고 비용이 올라갑니다."
3. During generation: same placeholder tiles, plus **"Pro 모드 적용 중"** chip if `proMode === true`.
4. When candidates land: **★ AI 추천 crown** on the judge winner (if judge ran).
5. User still clicks to select. No auto-select.

Operator does NOT see:
- Mode selector dropdown
- Cost preview
- Pass progress
- Rate-limit banner
- Legacy/v1_safe/v1_experimental toggles

All of those move to an **operator admin panel** that doesn't exist yet and is explicitly deferred to the E2 auth slot's companion work.

---

## 5. Merge conflict resolution

Automated `git merge` simulation showed:

| File | Conflict type | Resolution |
|---|---|---|
| `.gitignore` | Hunk collision in final section | Manual — keep both additions (node_modules + .venv + Playwright artifacts). |
| `app.py` | Auto-merge OK | No action. Step2-rebuild's additions at lines ~2009-2323, refactor-plan's at ~1344-1440, no overlap. |
| `frontend/src/studio/__tests__/api.test.js` | Auto-merge OK | Step2-rebuild's 4 new tests for `buildCompositeBody` stay; adjust import path to `../api/composite` (refactor-plan moved the function). |
| `frontend/src/studio/api.js` | Modify/reduce conflict | Drop step2-rebuild's changes to this file; migrate equivalent change to `src/api/composite.ts` (prod-default `step2Mode: "v1"`). |
| `frontend/src/studio/Step2Composite.jsx` | Modify/delete | File stays deleted. Apply Option-C++ remap per §3.3 to the decomposed `step2/*.tsx` files. |

### 5.1 Expected manual effort

**Codex #4 correction:** initial half-day estimate is too optimistic.
PR #2 is not "just a remap" — the current `main` Step 2 SSE contract
only has `init/candidate/error/fatal/done`. step2-rebuild adds new
event types (`ranked`, `pass`, plus `init.tier/estimated_cost`), a
`step2Mode`/`forceFlash`/`proMode` form-field surface on `/api/composite/
generate[/stream]`, and backend modules under `modules/step2/*`. Even
with 2-pass + mode selector trimmed per Option C++, the remaining
surface is:

- Backend: new `modules/step2/*` files (prompt_builder, sanitize,
  judge, policy, rate_limit, cost) — mostly drop-in copies from
  step2-rebuild, ~1-2 hours to rebase + remove two_pass paths.
- `app.py` composite_generate + composite_generate_stream: accept
  `step2Mode` + `proMode` form fields, thread through to orchestrator,
  emit `ranked` SSE event when judge runs. ~2-3 hours.
- Frontend `api/composite.ts`: add `step2Mode` (always `"v1"`) +
  `proMode` pass-through in `buildCompositeBody`. ~30 min.
- Frontend `useCompositeGeneration.ts`: extend stream handler for new
  `ranked` + `init.tier` events. ~1-2 hours.
- Frontend `step2/*.tsx` remap: judge crown on `CompositionVariants`,
  Pro toggle + "Pro 모드 적용 중" chip on `CompositionControls`,
  streamState consumption in `Step2Composite` container. ~2-3 hours.
- Tests per §10: snapshot integration test + 2 e2e + 2 vitest +
  pytest. ~3-4 hours.

**Revised total: 1.5-2 days** for merge + verification, not half-day.

Break into 2 sub-PRs to keep each reviewable:
- **PR #2a:** backend (modules/step2/*, app.py SSE extension) — mergeable
  without frontend changes since new events are additive.
- **PR #2b:** frontend (api/composite.ts, useCompositeGeneration, step2/*.tsx
  remap) — consumes #2a's events.

This way either sub-PR can roll back without leaving the system in a
broken middle state.

---

## 6. Step 3 naturalness track — MOTION (FlashTalk path)

**Correction from Codex outside-voice review:** earlier draft targeted
MultiTalk. Production single-host video path uses **FlashTalk**
(verified at `app.py:735, 1235` — both call sites pass
`config.FLASHTALK_OPTIONS["default_prompt"]`). MultiTalk is the
2-agent conversation path only (`app.py:1725`). All §6 PRs edit the
FlashTalk surface.

### 6.baseline Current state inventory (must read before any §6 PR)

Already-applied levers in FlashTalk path:
- **Prompt tuning** (`config.py:37-48`): "subtle, natural hand gestures
  and minimal, stable body movement... not exaggerated." Past iteration
  already pushed against over-articulation.
- **Audio loudness normalization** (`config.py:51-54, app.py:485-497`):
  `audio_lufs=-33` (10 dB below the `loudness_norm()` default of -23).
  Documented intent: "Lower = subtler mouth movement." Already
  attenuated. Further lowering risks audio-sync drift (lip motion
  de-correlates from words).

This changes what "S3-A audio preprocessing" means — we are NOT starting
from silence-on-the-audio-lever. We are tuning an already-applied lever.

### 6.0 S3-0: Baseline eval set (MUST land first)

Gate for every other S3-* PR. Same philosophy as earlier: 6-8 fixtures
prioritizing real B2B operator samples over synthetic. Rubric as
specified.

Critical fixture choice: **input audio must vary on characteristics
that interact with `audio_lufs`** — speakers with different vocal
effort levels, different recording conditions, different script
emotional intensity. Otherwise a single fixture set might lock in
an unrepresentative setting for the LUFS knob.

Helper `eval/step3/run_eval.py` takes a config override dict, writes
result manifest. Shared `eval/common/` machinery per DRY note.

### 6.1 S3-A: audio_lufs sweep + supplementary compression

Not a new preprocessing module built from scratch. Instead:

- Sweep `FLASHTALK_OPTIONS["audio_lufs"]` across `{-23 (default), -30,
  -33 (current), -36, -40}`. Score each on the S3-0 rubric. The current
  `-33` is a single-point bet; prove it's near-optimal or find a better
  value.
- If LUFS sweep hits a floor (going lower hurts sync more than it helps
  over-articulation), introduce a downstream compressor/limiter with
  threshold tuned per-fixture. Compressor reduces dynamic range
  differently from LUFS attenuation.
- Feature flag: `FLASHTALK_OPTIONS["audio_preproc_mode"]` with values
  `"lufs_only" (current) / "lufs_plus_compressor"`.

**Skip this PR entirely if LUFS sweep shows `-33` is already optimal** —
don't add a compressor module for theoretical gain.

### 6.2 S3-B: FLASHTALK_OPTIONS.default_prompt sweep

Candidate positive additions:
- "The mouth closes fully between words, not held open."
- "Lip movements are small and natural, matching quiet conversational
  speech, not shouting or singing."
- "Hands rest quietly at sides; occasional small gesture only."

Candidate negative additions (currently only pipeline default via
`pipeline.sample_neg_prompt`):
- "exaggerated mouth opening, wide-open jaw, teeth showing constantly"
- "wild hand swings, flailing, rapid gestures"
- "body sway, shoulder bouncing, head bobbing"

Sweep design: baseline vs {prompt_v2, prompt_v3, neg_v2, prompt_v2+neg_v2}.
5 configs × 3 seeds × 6-8 fixtures. Commit winner to
`FLASHTALK_OPTIONS["default_prompt"]` (and add `neg_prompt` if FlashTalk
pipeline exposes override path — verify; falls back to pipeline default
if not).

### 6.3 S3-C: reference frame preprocessing — TARGETED AT STEP 2 OUTPUT

**Codex correction #5:** the animation source is `composition.selectedPath
|| host.selectedPath` (`frontend/src/api/video.ts:81`), not always Step 1.
The composite from Step 2 is what FlashTalk animates. Fixing Step 1's
mouth posture alone can be overwritten when Step 2 composites through.

Revised S3-C targets the **final composition frame** before it reaches
FlashTalk:
- Detect mouth aperture on the **selected composite** (not on Step 1
  candidates) using MediaPipe face mesh
- If open > threshold, either warn the operator with a "선택한 이미지의
  입이 열려 있어요, 움직임이 과해질 수 있어요" hint, or re-composite
  with a "closed mouth" constraint in the Step 2 prompt (more invasive)
- Non-blocking warning first; hard gate only after usage data shows it
  matters

Note scope creep: this ties §6 to §3 (Step 2 rebuild). Consider
deferring until step2-trim lands if the coupling is too tight.

### 6.4 S3-D: CFG scale sweep (FlashTalk)

Check FlashTalk pipeline for CFG scale exposure. If exposed via
`FLASHTALK_OPTIONS` or pipeline config, sweep `{5.0, 6.0, 7.5 (likely
current), 9.0}`. If not exposed, either skip or add exposure.

### 6.5 S3-E (deferred): commercial model fallback

### 6.0 S3-0: Baseline eval set (MUST land first)

Gate for every other S3-* PR. Without a fixed eval set each lever's A/B
result is unrepeatable subjective impression.

**Fixture count philosophy:** fixture_count is NOT a quality multiplier.
It's measurement-confidence × reviewer-time, both of which have
diminishing returns. A small set of real-world B2B operator samples
with a detailed rubric outperforms 20 synthetic samples scored quickly.
The reviewer bottleneck (single person, subjective rubric) hard-limits
signal strength regardless of count.

Establishes:

- **6-8 input fixtures** in `eval/step3/fixtures/` (not 20):
  - Prioritize **real B2B operator submissions** (with permission) over
    synthetic. 4-6 real samples beats 20 synthetic.
  - Cover 3 known failure modes explicitly: short-script (common
    failure), long-script (rare failure, high value if caught), emotional
    register (mid-severity, non-obvious).
  - Each fixture = `(audio.wav, reference_frame.png, script.txt)` triple.
  - If <4 real samples available, pad with synthetic targeting the same
    failure modes — but label them distinctly so we know which are
    "real-world signal" vs "synthetic probe".
- **Baseline renders** at `eval/step3/baseline/`: current `MULTITALK_OPTIONS`
  run through unchanged code, one render per fixture, hash-pinned.
- **Rubric** in `eval/step3/RUBRIC.md`:
  - Dimension 1: mouth over-articulation 0–4 (0 = natural, 4 = cartoonish)
  - Dimension 2: body/hand motion naturalness 0–4
  - Dimension 3: sync tightness 0–4
  - Dimension 4: overall "would show a client" 0–4
  - Reviewer scores on 20 fixtures → 80 points total per render
  - Delta vs baseline is the metric every subsequent PR reports
- **Helper script** `eval/step3/run_eval.py`: given a config override dict,
  regenerates 20 renders and writes a manifest. Reviewer's scoring goes
  into `eval/step3/results/{timestamp}.json`.

Exit criteria for S3-0: baseline scored by at least one reviewer (typically
the user), baseline scores committed to repo as ground truth. Any future
PR must show a positive delta on the rubric to merge.

Effort: half a day to set up fixtures + script, plus however long it
takes to score the baseline (20 renders × ~15 sec each to eyeball = ~5
min of scoring, or longer if careful).

**DRY note:** §6B.0 (V-0 TTS eval set) mirrors this structure. Put
shared machinery (fixture loader, rubric scoring CLI, result persistence,
delta-vs-baseline reporter) in `eval/common/` and have `eval/step3/` +
`eval/step3-tts/` import/extend. Avoids maintaining two copies of the
same ~200-line helper.

### 6.X (OBSOLETE — kept only to record what the earlier draft said)

Pre-Codex-review draft targeted MultiTalk and assumed no existing audio
preprocessing. Replaced entirely by §6.baseline + §6.0 + §6.1-§6.4
above. Content below kept verbatim for 2 weeks so we can compare how
the plan evolved.

### 6.1 S3-A: Audio preprocessing (highest-leverage lever, no-model)

Lip motion magnitude in audio-driven talking-head models tracks audio envelope. Reducing dynamic range via RMS normalize + compressor before feeding audio into MultiTalk typically yields 30-40% reduction in over-articulation.

- New module `modules/audio_preproc.py`
- Apply before `multitalk_inference.generate_video`
- Feature flag `AUDIO_PREPROC_ENABLED` in config for A/B
- A/B harness: same script + seed, with and without preproc, 10 samples each, visual review

### 6.2 S3-B: Prompt sweep A/B

Candidate positive prompt additions:
- "The mouth closes fully between words, not held open."
- "Lip movements are small and natural, matching quiet conversational speech, not shouting or singing."
- "Hands rest quietly at sides; occasional small gesture only."

Candidate negative prompt additions (currently only model default):
- "exaggerated mouth opening, wide-open jaw, teeth showing constantly"
- "wild hand swings, flailing, rapid gestures"
- "body sway, shoulder bouncing, head bobbing"
- "cartoonish expression, theatrical emotion"

Sweep design: baseline vs {prompt_v2, prompt_v3, neg_v2}. ~8 configs, 3 seeds each = 24 samples. Manual review (or LLM-as-judge later).

### 6.3 S3-C: Reference-frame preprocessing

Talking-head diffusion models use the input image as motion prior. If the reference shows an open mouth mid-word or animated expression, the model amplifies it. Ensuring the reference frame has a closed, neutral mouth reduces over-articulation.

- Detect input frame's mouth aperture (simple: MediaPipe face mesh, or an LLM classifier)
- If open > threshold, regenerate Step 1 candidates with "closed mouth, neutral expression" prompt addition
- Optional: crop/warp mouth closed (risky — can distort face)

Effort: ~2 days.

### 6.4 S3-D: CFG scale sweep

Current CFG likely 7.5. Lowering to 5.0-6.0 reduces text-prompt influence, lets the model revert to its training prior (which may be more natural). Risk: audio sync drift.

Sweep: 5.0, 6.0, 7.5 (current), 9.0 on the same audio + seed. Effort: half a day.

### 6.5 S3-E (deferred): commercial model fallback

If S3-A through S3-D hit a ceiling, consider routing "quality-critical" renders to Hedra / D-ID / HeyGen Studio. Major integration cost + recurring API fees. Don't plan this yet; flag as future if quality gap remains.

### 6.6 Sequencing within S3 (motion/lip track)

Run S3-A first (cheapest, highest-leverage). Then S3-B. S3-C depends on
having audio that already behaves well (S3-A), so run third. S3-D last
(CFG is a blunt knob).

---

## 6B. Step 3 TTS quality track (parallel to §6 motion track)

Surfaced late in plan review: user reports inconsistent output when
generating audio from their own voice clone + script. Typical failures:
- Output not clean (breathing noise, bad prosody)
- Filler interjections ("아", "음") inserted where the script has none
- 5 generations of the same script produce 5 different qualities

These are **TTS-layer problems, not MultiTalk** — distinct from §6 and
run on a separate clock. Can execute in parallel with §6 (they share
only reviewer time).

### 6B.0 V-0: TTS baseline eval set (MUST land first)

Same fixture philosophy as §6.0 — real samples > fixture count.

- **9 input fixtures** in `eval/step3-tts/fixtures/` (not 30):
  - 3 clone sources (1 real B2B operator, 1 phone-recorded, 1 noisy
    sample to stress-test gating)
  - 3 scripts each covering the 3 known TTS failure modes: run-on
    sentences (filler trigger), ambiguous punctuation (prosody error),
    numeric/English-mixed (pronunciation variance)
  - Re-used across all V-* PRs. Cost incurred once at PR #8, amortized.
- **Baseline renders** at `eval/step3-tts/baseline/`: current
  `modules/elevenlabs_tts.py` run unchanged.
- **Rubric** in `eval/step3-tts/RUBRIC.md`:
  - Dimension 1: audio cleanliness 0–4 (background hiss, glitches)
  - Dimension 2: fidelity to script 0–4 (extra fillers = -1 per)
  - Dimension 3: prosody naturalness 0–4
  - Dimension 4: consistency — re-run same input 3× and score variance
    (low variance = 4, high = 0)
- **Helper** `eval/step3-tts/run_eval.py`.

### 6B.1 V-A: Script preprocessing (highest leverage, no API cost)

Hypothesis: ElevenLabs TTS fillers and prosody errors trace back to
ambiguous punctuation + run-on sentences. Pre-process every script
before sending:

- Normalize punctuation (mixed 。 . ... → `.` then SSML-style `<break>`)
- Split sentences longer than ~40 Korean chars at clause boundaries
- Insert `<break time="200ms"/>` at clause joints (if ElevenLabs
  supports SSML for Korean — verify; otherwise use newline-as-pause)
- Strip trailing interjections in source that could bleed through

New module `modules/tts_preproc.py`. Feature flag
`TTS_SCRIPT_PREPROC_ENABLED`.

### 6B.2 V-B: Clone quality gate (prevent bad input before Generate)

**Codex correction #7:** current flow does NOT clone at upload time. It
stages a file; the ElevenLabs clone call fires on "Generate." So
"upload gate" language was wrong. Correct framing:

Validate at the **post-upload, pre-Generate** step (file-staging), not
at file-select. The operator uploads → file sits in state → operator
hits Generate → validation runs before the ElevenLabs API call. If
validation fails, show warning inline on the voice-cloner UI and block
Generate until dismissed (hard gate once calibrated; non-blocking
warning until then).

- Minimum length (e.g. 30 seconds)
- Maximum silence ratio (>20% silence → reject)
- Minimum SNR (simple: RMS over silence threshold)
- Warn user with actionable copy ("목소리 샘플이 짧아요 — 최소 30초 녹음 권장")

Runs in `modules/audio_validation.py`. Wired into the
pre-Generate validation hook in `useTTSGeneration.ts` AND surfaced at
`VoiceCloner.tsx` (UI warning). Non-blocking warning by default; turn
into hard reject once thresholds are calibrated against real B2B
customer samples.

**Codex #3 — TTS path fragmentation:** TTS runs on TWO endpoints:
- `/api/elevenlabs/generate` — preview (Step 3 UI "목소리 듣기" button)
- `/api/generate` with `audio_source=elevenlabs` — final render TTS
  call (different param handling; see `app.py:1206` — final path
  hardcodes `speed` from config, ignores UI speed slider)

Both paths MUST receive the same preprocessing, params, and validation.
Current code has them diverge silently. Any V-* PR's tests must cover
BOTH endpoints or the "improvement" lands only on preview, not final
render. Concrete test: parametrize `tests/test_tts_param_parity.py`
across both call sites.

### 6B.3 V-C: TTS parameter sweep

Current defaults: `stability=0.5`, `similarity_boost=0.75`,
`style=0.0`, `speed=1.0` (from `app.py:1144-1146`).

Sweep: {stability ∈ [0.3, 0.5, 0.7, 0.9]} × {style ∈ [0.0, 0.2]}
against V-0 eval set. Pick config that minimizes filler rate AND
maximizes consistency (V-0 rubric dim 2+4).

Commit winning config to `config.ELEVENLABS_OPTIONS`. Cost: 30 fixtures
× 8 configs = 240 TTS calls ≈ $2-3 one-time.

### 6B.4 V-D: Multi-gen auto-reject

ElevenLabs is non-deterministic. Generate N=3, score each on:
- VAD-based filler detection (look for `~200ms audio` not matching any
  phoneme in the input script — that's a filler)
- Length mismatch vs expected (script word-count → expected duration)
- Silence ratio at boundaries

Return the best of N. Cost triples but quality variance drops. Exposed
as a feature flag `TTS_MULTI_GEN_N` defaulting to 1 (current behavior),
flip to 3 after cost analysis.

### 6B.5 V-E (deferred): Alternative TTS models

If V-A through V-D hit ceiling, pilot:
- OpenAI TTS (non-Korean-native but high consistency)
- Naver Clova Voice (Korean-native, ElevenLabs competitor in region)
- Google Chirp 3

Decision deferred until V-A..D eval results show a clear ceiling.

### 6B.6 Sequencing within §6B

Run V-0 first (gate). Then V-A (script preproc — biggest leverage,
zero API cost). Then V-B (quality gate — prevents the problem upstream).
Then V-C (param sweep). Then V-D (multi-gen — 3× cost, justify only if
V-A+B+C leave residual variance).

### 6B.7 Shared concerns with §6

- Both tracks need reviewer time. Cap: ≤2 eval passes per week across
  both tracks. Schedule deliberately.
- **Cost-of-measurement budget:** eval fixtures are re-used; per-PR
  eval cost = (6-8 S3 renders × GPU time) + (9 V-0 renders × ElevenLabs
  API). GPU time is the bottleneck (single worker per `task_queue.py:155`).
  Eval pass on S3 = ~30 min wall-clock. Budget 1 hour per S3 PR; skip
  eval on "obvious no-change" PRs. V-0 eval pass = ~3 minutes (API only).
- Both tracks feed the same end-to-end "would show a client" perception.
  Final user-facing quality = TTS quality ⊗ MultiTalk quality. A good
  TTS fed into a bad MultiTalk still produces a bad final video.
- Add a §6C combined end-to-end eval pass quarterly (TTS winner + motion
  winner) to catch interaction effects.

---

## 7. Operator admin panel (deferred)

Everything Option C++ removed from end-user UI belongs here. Not in this merge cycle.

- Mode selector (legacy / v1 / v1_experimental)
- Cost dashboard (today's spend, per-operator, per-mode)
- Rate-limit status + override
- Bakeoff trigger + results view
- Prompt version pinning for producer-specific styles

Gated on E2 (auth + user-scoping) from `REFACTOR_PLAN.md §Decisions #11`. Admin ≠ operator, need at least operator-role distinction.

---

## 8. Sequence / PR plan

| PR | Branch | Base | Contents | Merge criteria |
|---|---|---|---|---|
| #1 (open) | `refactor-plan` | `main` | 22 commits structural refactor + CI fix | CI green ✓, browse-smoke ✓, self-review ✓. **Merge now.** |
| (no PR — interview) | — | — | **Persona validation checkpoint.** 30-minute interview with B2B first customer: (a) actual operator volume/day, (b) operator tech-literacy profile, (c) does operator bill clients per-video (→ needs cost visibility), (d) how many of their own operators will use this. Findings re-gate §3.1 (judge), §3.2 (cost preview removed), §4 (Pro toggle copy). Writeup goes into `docs/persona-validation.md`. | Plan §3.1-§4 re-examined and either confirmed or revised |
| #2 | `step2-trim` (new) | `main` (after #1 + persona validation) | Rebase `step2-rebuild` onto `refactor-plan`, apply Option C++ trim (possibly adjusted by persona findings), resolve conflicts per §5 | CI green, vitest 139+ pass, playwright 12+ pass, operator walks through happy path on worktree dev server |
| #3 | `step3-eval-baseline` | `main` (after #1 + persona — **NOT after #2**) | S3-0 eval fixtures + baseline + rubric + helper script | Baseline scored by at least 1 reviewer |
| #4 | `step3-audio-preproc` | `main` (after #3) | S3-A `audio_lufs` sweep + optional compressor | Positive rubric delta OR proof that -33 is already near-optimal |
| #5 | `step3-prompt-tuning` | `main` (after #4) | S3-B FLASHTALK prompt + neg_prompt sweep winner | Positive rubric delta vs baseline+S3-A |
| #6 | `step3-reference-frame` | `main` (after #5 AND #2) | S3-C **composite-frame** preprocessing (depends on step2-trim for the selected-composite code path) | Positive rubric delta |
| #7 | `step3-cfg-sweep` | `main` (after #6) | S3-D FlashTalk CFG scale default tuning | Positive rubric delta |
| #8 | `step3-tts-eval-baseline` | `main` (after #1, parallelizable with S3 track) | V-0 TTS fixtures + baseline + rubric | Baseline scored |
| #9 | `step3-tts-script-preproc` | `main` (after #8) | V-A script normalization + SSML **applied to BOTH preview `/api/elevenlabs/generate` AND final `/api/generate` when `audio_source=elevenlabs`** | Positive V-0 rubric delta |
| #10 | `step3-tts-clone-gate` | `main` (after #8) | V-B clone quality validation **at file-staging step, not upload** (clone happens on Generate, not on file select) | Uploads meeting threshold pass, bad ones warn |
| #11 | `step3-tts-param-sweep` | `main` (after #9) | V-C winning params committed to `ELEVENLABS_OPTIONS` AND passed through on both preview + final paths | Positive V-0 rubric delta |
| #12 | `step3-tts-multi-gen` | `main` (after #11, optional) | V-D multi-gen auto-reject | Variance (rubric dim 4) improves by ≥1 point |

Each PR small enough to review in one sitting. No super-PRs.

Parallelization: §6 (motion) and §6B (TTS) share only reviewer time.
Different code areas. #3 and #8 can land in the same week; #4 and #9 too.
The constraint is the reviewer doing eval scoring, not code conflicts.

---

## 9. Rollout / feature flag strategy

### 9.1 Step 2

- Legacy prompt path kept for ONE week post-merge behind `STEP2_ALLOW_LEGACY=1` env. Default off. Lets us roll back quickly.
- v1 prompt is prod default, always used when flag is off.
- Judge runs by default. Can be disabled per-request via `disable_judge=true` form field (not in UI, for ops only).

### 9.2 Step 3

- Every S3-A/B/C/D change behind its own boolean in `config.MULTITALK_OPTIONS`.
- Default = current behavior. Flip to new behavior only after A/B approves.
- Old prompt/preproc stays in code for 2 weeks post each change, then removed.

### 9.3 Feature flag safety invariant

All feature flags in this plan (STEP2_ALLOW_LEGACY, MULTITALK_OPTIONS.*,
TTS_SCRIPT_PREPROC_ENABLED, TTS_MULTI_GEN_N) MUST fail closed — if the
env var is missing, malformed, or parses to an unexpected type, the code
falls back to the prior (known-working) path, not to the new path.
Rationale: a typo in deployment config should never silently enable an
untested code path on prod.

Canonical pattern:
```python
def _bool_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if raw in ("1", "true", "yes", "on"): return True
    if raw in ("0", "false", "no", "off", ""): return default
    logger.warning(f"{name}={raw!r} unrecognized; using default {default}")
    return default
```

Add unit tests for the parser at introduction time. Not per-flag.

---

## 10. Test coverage additions

Each PR in §8 lands with tests matching the coverage diagram §3 produced.
Requirements per PR, in plan order:

### PR #1 (refactor-plan) — already shipped
139 vitest + 12 playwright + CI green. No action.

### Persona validation checkpoint (no PR)
- `docs/persona-validation.md` includes the interview rubric used, raw
  findings, and a "decision delta" section listing which §3-4 plan items
  moved as a result. No automated test (it's a qualitative gate).

### PR #2 (step2-trim)
Add:
- `tests/test_step2_mode_plumbing.py` (pytest) — `composite_generate`
  endpoint accepts `step2Mode=v1` form field, default is v1 when field
  absent. Guards backend against silent revert to legacy.
- `frontend/src/studio/step2/__tests__/step2_judge_crown.test.jsx`
  (vitest) — given SSE `ranked` event with `winner=N`, crown renders on
  tile N, click on crowned tile still goes through normal selection.
- `frontend/e2e/step2-pro-toggle.spec.ts` (playwright) — toggle Pro,
  generate, assert form body contains `proMode=true` via `page.route()`
  interception.
- **`tests/integration/test_step2_remap.py`** (critical — closes Q3b):
  snapshot test. Uses fixtures captured from step2-rebuild's original
  `Step2Composite.jsx` behavior (streamState fields exercised, judge
  crown shown, ranked event handled) and asserts the decomposed
  `step2/*.tsx` tree produces equivalent observable behavior. Snapshot
  here means DOM structure + SSE→state mapping, not pixel diff.

### PR #3 (step3-eval-baseline) — S3-0
- `eval/step3/test_rubric_loader.py` — rubric JSON schema valid, scores
  parseable.
- The baseline itself is the test artifact.

### PR #4 (step3-audio-preproc) — S3-A
- `tests/test_audio_preproc.py` — compressor reduces peak/RMS ratio on
  synthetic audio (pulses, sustained tones, silence+bursts).
- **Regression guard (critical — closes Q3d):** PR merges only if
  `eval/step3/run_eval.py --config audio_preproc=on` shows
  `rubric_delta >= +3 AND no dimension regressed > 1 point`. Encoded as
  a CI step that runs the eval and parses results.

### PR #5-7 (S3-B/C/D)
Same regression guard as PR #4. Each PR's merge criteria includes:
- Rubric delta positive vs baseline
- No dimension regressed more than 1 point vs **previous S3 landed PR**
  (not just baseline). Enforces "each step preserves prior wins."
- `tests/test_multitalk_prompt_injection.py` (S3-B only) — verify new
  negative prompts make it into `pipeline.sample_neg_prompt` at pipeline
  instantiation.

### PR #8 (step3-tts-eval-baseline) — V-0
- Mirrors PR #3. Shared `eval/common/` machinery per §6.0 DRY note.

### PR #9 (step3-tts-script-preproc) — V-A
- `tests/test_tts_preproc.py` — unit tests on script normalization:
  punctuation, long-sentence split, SSML emission.
- Regression guard: V-0 rubric delta positive AND dim 2 (fidelity)
  specifically improves by ≥1 point (this is the filler-insertion case).

### PR #10 (step3-tts-clone-gate) — V-B
- `tests/test_audio_validation.py` — clone source too short → warning
  object returned; too noisy → warning; acceptable → pass.
- **`frontend/e2e/voice-cloner-quality-gate.spec.ts`** (closes Q3e):
  upload a too-short sample via playwright, assert warning message
  visible, form submit still allowed (non-blocking).

### PR #11 (step3-tts-param-sweep) — V-C
- Committed config change only. Test is the V-0 rubric delta.

### PR #12 (step3-tts-multi-gen) — V-D
- **`tests/test_multi_gen_reject.py`** (closes Q3f): feed 3 synthetic
  TTS outputs (1 clean, 2 with fillers) into the scoring logic, assert
  the clean one is selected.
- V-0 rubric delta positive, variance (dim 4) improves ≥1 point.

### Coverage targets

Stay at current vitest thresholds (lines 60, functions 60, branches 50,
statements 60). Pytest coverage not formally enforced but new tests
should not decrease line coverage on touched modules.

### Eval gate operational model (Codex correction #9)

Rubric-delta merge gates cannot run in CI — they need GPU, external
TTS API calls, and manual human scoring. Concrete operational model:

- **Merge gate = checklist in PR description**, signed off by
  reviewer after running eval locally.
- Reviewer runs `eval/step3/run_eval.py --config <change>` on their
  workstation. Output manifest committed to the PR at
  `eval/step3/results/<pr-number>.json`.
- PR merge requires the manifest file AND rubric-delta section in PR
  description.
- Not CI-enforced — honor-system. Add a CODEOWNERS rule so reviewer is
  an explicit person, not "anyone."
- CI can still enforce: "if PR touches `config.FLASHTALK_OPTIONS` or
  `eval/step3/fixtures/`, the PR must include a file at
  `eval/step3/results/<pr-number>.json`" (shape check, not quality
  check). That's doable in CI. Rubric interpretation stays human.

---

## 11. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Option C++ trim removes features the operator actually needed (e.g., cost visibility is demanded by finance) | Medium | High | Operator admin panel PR immediately after step2-trim. Not in this merge but scoped. |
| R2 | Rebase of step2-rebuild onto refactor-plan takes longer than estimated half-day | Medium | Low | If >2 days, reconsider and cherry-pick individual commits instead of rebase. |
| R3 | New v1 prompt actually makes things worse in edge cases legacy handled | Low | High | Legacy flag kept for a week, prod-quality monitoring via `cost_actual_usd` + judge failure rate. |
| R4 | Audio preprocessing changes voice timbre (not just dynamics) | Medium | Medium | Use compressor with -3dB threshold + 2:1 ratio, not aggressive limiting. A/B with volume-matched samples. |
| R5 | Step 3 prompt tuning hits ceiling; real fix needs model swap | Medium | Medium | Capped at 4 sub-PRs (S3-A through S3-D). If quality still insufficient, S3-E (commercial) enters planning. |
| R6 | Judge verdict disagrees with human picks often enough that "★ 추천" loses trust | Low | Medium | Track "user picked judge winner" rate in `cost_actual_usd` logs. If <50% after 200 renders, remove crown. |
| R7 | Legacy-flag-off default breaks an existing integration we don't know about | Low | High | Before flipping default, grep codebase for `step2Mode` callers; if any exist beyond this app, contact owner. |
| R8 | **Persona assumption wrong.** Plan §3-4 UI decisions (judge kept, cost preview removed, Pro toggle exposed) assume an operator profile inferred from product + industry signals, not interviewed. If first-customer operators actually bill per-video and want cost visibility, or are too junior for even the Pro toggle, we ship wrong UI. | Medium | Medium | Persona validation checkpoint between PR #1 and PR #2 (see §8). 30-min interview. If findings contradict §3-4, adjust before step2-trim lands. |
| R9 | **TTS quality interacts with motion quality.** S3-A..D might land "clean" on static eval sets but feel worse when combined with V-A..D TTS changes (e.g. smoother TTS makes marginal lip-sync tightness problems more obvious). | Medium | Medium | §6C end-to-end eval pass quarterly. When a §6 AND §6B PR both land in the same sprint, run a combined eval before calling "improved" on either. |
| R10 | **Gemini 3 preview model deprecation / price change.** Both `gemini-3.1-flash-image-preview` and `gemini-3-pro-image-preview` are `-preview` — Google can pull, rename, or reprice with short notice. | Low | High | Quarterly check of [ai.google.dev pricing](https://ai.google.dev/gemini-api/docs/pricing) + model list. Keep `modules/step2/prompt_builder.py` model-agnostic (already is). Budget flag for fallback to `gemini-3` non-preview when it GAs. |

---

## 12. Success criteria (B2B-specific)

- **Functional:** Operator can complete wizard steps 1-2-3 and render a video without seeing any option labeled "experimental", "beta", "legacy", or "v1". CI + playwright prove this.
- **Quality (Step 2):** On a frozen 20-prompt eval set (different products, backgrounds, spatial directions), v1 prompt output rated "natural" by an internal reviewer at ≥70% rate vs legacy baseline ≤40%. B1/B2/B3 cited bugs resolved in >90% of relevant cases.
- **Quality (Step 3):** On the same eval set rendered end-to-end, perceived lip over-articulation reduced. Target: internal reviewer rates the output "distracting mouth movement" ≤10% (baseline likely >50% per user's description).
- **Ops:** Judge win-rate (user-pick matches judge-winner) ≥65%. Below that, the crown's value is doubtful.
- **Cost:** Monthly spend stays within forecast (~$800-1500/month at first-customer volume). Tracked in backend logs.
- **Dev velocity:** Average PR size stays ≤500 LOC post-step2-trim merge. If super-PRs start appearing it means the admin-panel deferral is leaking.

---

## 13. Non-goals

- No new model integrations in this plan (no Hedra/D-ID/HeyGen). S3-E is a future option.
- No full operator admin panel. Deferred behind E2 auth.
- No multi-product support design for Step 2 (P3 from context). Scope it separately once first-customer volume hits whatever product count they actually need.
- No auth / multi-tenancy. E1-E6 slots remain unfilled per REFACTOR_PLAN.md.

### Codex #8 — UI simplification consistency

Codex flagged: this plan hides Step 2 expert controls (mode selector,
cost preview) while Step 3 keeps raw ElevenLabs sliders (stability,
style, similarity, speed) visible at
`frontend/src/studio/step3/VoiceAdvancedSettings.tsx:12`. If the operator
is "too junior for a Step 2 mode selector," they are plausibly also too
junior for ElevenLabs tuning knobs. The operator/admin split is
selectively applied.

Deliberately deferred to the operator admin panel PR (after E2 auth).
Both Step 2 and Step 3 expert controls should move there together.
Doing one without the other creates exactly the inconsistency Codex
points at. Flagged here so we don't forget.

---

## 14. Open questions for review

1. Is the assumption "operator ≠ end-customer UI" correct? If the first customer's operators ARE the producers and want the cost preview themselves, §4 UI shape is wrong.
2. Is the legacy-flag one-week window enough, or do we need feature-flag gradual rollout (10% → 50% → 100%)?
3. Is the judge's "★ 추천" crown copy the right register? User-facing copy review deferred — engineers shouldn't finalize.
4. Should S3-A through S3-D be behind a single feature flag group or 4 independent flags?
5. Merge #2 (step2-trim) — single combined PR or pair of PRs (backend first + frontend remap after)?

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (plan is sequencing/integration, not product scope) |
| Codex Review | `/codex review` (outside voice in this session) | Independent 2nd opinion | 1 | issues_found | 9 findings: 4 critical (MultiTalk→FlashTalk targeting error §6, audio_lufs=-33 already wired, TTS preview↔final path divergence, eval gates not CI-ready); 5 integrated (sequencing contradiction, remap effort estimate, ref frame wrong stage, V-B clone flow misunderstanding, UI simplification consistency) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_found | 14 total issues: 3 arch (resolved), 2 code quality (resolved), 6 test gaps (all specified), 3 perf (resolved). Plan rewritten substantially mid-review after Codex caught wrong-subsystem targeting. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a — plan is sequencing + infra, UX deltas are specified but not full design review |
| DX Review | `/plan-devex-review` | DevEx gaps | 0 | — | n/a — not a dev-facing product |

- **CODEX:** 9 findings, 4 critical (wrong subsystem § 6 → rewrote targeting FlashTalk; audio_lufs=-33 already wired → §6.baseline added; TTS path fragmentation → §6B.2+.3 corrected; eval gates not CI-ready → §10 operational model added). 5 non-critical integrated inline.
- **CROSS-MODEL:** Eng review and Codex agreed on the B2B persona risk (R8) and the Step 2 Option C++ scope. They DISAGREED initially on subsystem targeting (§6 MultiTalk vs FlashTalk) — Codex was right, plan rewritten. Eng review missed this because it didn't verify which pipeline the production path uses. Lesson logged: always grep for actual call sites before tuning a config surface.
- **UNRESOLVED:** 0. All AskUserQuestion prompts answered; all findings either integrated into plan or explicitly deferred.
- **VERDICT:** ENG CLEARED (PLAN) — integration plan ready for implementation, starting with persona validation checkpoint before PR #2. Step 3 tracks (§6 motion, §6B TTS) can parallelize with step2-trim as §8 sequence table shows.
