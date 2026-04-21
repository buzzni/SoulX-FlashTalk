# HostStudio Migration — Test Plan

> Companion to [`plan.md`](./plan.md) v2.5.
> TDD strategy: every Python test starts `@pytest.mark.skip`, every Vitest test starts `it.skip`. Unskip as each Phase lands implementation.

## 0. Quick Start

```bash
# Python
.venv/bin/python -m pytest            # all tests (most skipped)
.venv/bin/python -m pytest -m phase0  # only Phase 0 tests
.venv/bin/python -m pytest -v         # verbose with skip reasons

# Frontend
cd frontend
npm install
npm run test         # Vitest watch
npm run test -- --run  # single run
npm run test:cov     # with coverage
```

## 1. Test File Inventory

### Python (`tests/*.py`)
| File | Phase | Tests | Purpose |
|---|---|---|---|
| `test_image_compositor.py` | 0 | 11 | Gemini Flash swap, aspect_ratio, system_instruction, safety, prompt sanitize |
| `test_elevenlabs_tts.py` | 0 | 6 | v3 model, use_speaker_boost, language_code, speed, 5k limit, [breath] native |
| `test_upload_security.py` | 0 | 11 | magic-byte, size limit, filename, path traversal, ffmpeg SSRF |
| `test_host_generator.py` | 1 | 8 | N=4 parallel, partial failure, timeout, mode dispatch |
| `test_api_host_generate.py` | 1 | 5 | HTTP contract, validation, error surfacing |
| `test_api_hosts.py` | 1 | 4 | CRUD roundtrip, auth, disk full |
| `test_api_composite_generate.py` | 2 | 5 | rembg toggle, direction passthrough, enum validation |
| `test_progress_sse.py` | 4 | 3 | stream events, disconnect cleanup, orphan detection |
| `test_voice_pitch.py` | 4 | 4 | ffmpeg rubberband post-processing (D2) |

**Total Python: 57 placeholders** across 9 files.

### Frontend (`frontend/src/studio/__tests__/api.test.js`)
| Describe group | Tests | Phase |
|---|---|---|
| Step 1 host mapping | 9 | 3-4 |
| Step 2 composite mapping | 5 | 3-4 |
| Step 3 voice mapping | 9 | 4 |
| Resolution mapping | 3 | 4 |
| Upload choreography | 3 | 4 |
| Error handling | 3 | 4 |

**Total Vitest: 32 placeholders.**

**Grand total: 89 tests to unskip across Phases 0-4.**

## 2. Unskip Timeline (per Phase)

### Phase 0 — 17 tests
All tests in `test_image_compositor.py`, `test_elevenlabs_tts.py`, `test_upload_security.py`.
Gate: all P0 tests pass before Phase 1 merges.

### Phase 1 — 17 tests
All tests in `test_host_generator.py`, `test_api_host_generate.py`, `test_api_hosts.py`.
Gate: Phase 0 + Phase 1 all pass before Phase 2 merges.

### Phase 2 — 5 tests
All in `test_api_composite_generate.py`.

### Phase 3 — 17 Vitest
Step 1 + Step 2 mapping groups + resolution basics. Requires `src/studio/api.js` stub.

### Phase 4 — 30 tests (Python + Vitest)
`test_progress_sse.py` + `test_voice_pitch.py` + remaining Vitest groups (voice mapping, upload choreography, error handling).

### Phase 5-6 — E2E
No unit scaffolding; handled by `/qa` skill dogfood of full render flow.

## 3. Eval Harness (Phase 0 model transitions)

**Not pytest-runnable**: manual A/B comparison scripts.

### Gemini Flash vs Pro (10 samples)
- 10 text-prompt inputs representing Korean show-host use cases
- Generate Stage 1 (host) + Stage 2 (composite) on both models
- Metric: manual rating (1-5) on photorealism, Korean face fidelity, identity preservation (cosine similarity ≥0.7 for Stage 2)
- Pass gate: ≥8/10 samples rated ≥4 on Flash. Fail → revert Flash commit.

### ElevenLabs v3 vs v2 (5 voices × 1 script)
- Same script, same voice_id, v2 vs v3 model
- Metric: listening test for naturalness, Korean pronunciation, `[breath]` pause quality
- Pass gate: ≥4/5 voices rated ≥3.5/5 on v3. Fail → revert v3 commit.

### Artifacts
- `evals/phase0/gemini_flash_vs_pro/` — input prompts, output samples, ratings CSV
- `evals/phase0/elevenlabs_v3_vs_v2/` — wav files, blind listening spreadsheet

## 4. Coverage Gates

| Scope | Floor | Rationale |
|---|---|---|
| Python (new code only) | 60% | Tier-1 baseline. Raise to 80% post-V1. |
| `modules/host_generator.py` | 80% | New critical path; no legacy excuses |
| `modules/video_postprocess.py` | 80% | New (pitch post-process) |
| Frontend `src/studio/` | 60% | UI heavy, Vitest unit coverage only |

## 5. Out of Scope (V2)

- Visual regression (Playwright screenshot diff) — Phase 3 승인 조건으로 격상 권장, V1에서는 manual QA
- Load tests (Gemini N=4 concurrency under burst)
- Chaos tests (queue recovery, SSE reconnection storm)
- Accessibility Tier-2 (contrast ratio, focus trap, skip link — §6.2 D15)
