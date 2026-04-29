# Wizard Input ↔ Prompt Coherence — 종합 정리 plan

> 상태: 📋 **draft for /plan-eng-review** — 매핑 일관성 + UI 노출/숨김 + capability 활용 통합
> 작성일: 2026-04-29
> 관련 문서: [pipeline-v2/plan.md](../pipeline-v2/plan.md), [model-parameter-audit/TODO.md](../model-parameter-audit/TODO.md)

## 문제 정의

studio wizard의 3개 step에서 사용자가 입력한 값이 백엔드 generator/모델 프롬프트에 도달하기까지 3 layer를 거친다 — UI 컨트롤 → form-mappers/api-mappers → FormData/JSON 페이로드 → generator 슬롯. 각 layer에서 발견된 문제를 한 번에 정리.

**근본 질문**: 사용자가 만진 값이 (a) 모델 프롬프트에 도달하는가, (b) 도달했다면 사용자가 결과 차이를 체감할 수 있는가, (c) 안 만지는 capability는 노출 가치가 있는가.

---

## 그룹 A — 매핑 일관성 (백엔드 dead/double-encoding)

### A1. Step 1 강도 + 네거티브 프롬프트 이중 인코딩

**관찰**: `frontend/src/api/host.ts:51-65`에서 `strengthToClause`/`negativeToSystemSuffix`를 통해 강도값과 네거티브 프롬프트를 `extraPrompt` 본문에 미리 병합. 그런데 동일 raw 값이 별도 form 필드(`faceStrength`, `outfitStrength`, `negativePrompt`)로도 전송됨. 백엔드는:
- `modules/host_generator.py:454-468` — inline 라벨에 `_strength_phrase()`로 같은 문장 재생성
- `modules/host_generator.py:626-627` — system_instruction에 `f"Avoid the following in the output: {negative_prompt}"` 재생성

**모델 시점 영향**: "Match the reference face as exactly as possible." 가 프롬프트에 두 번 등장. system_instruction에도 "Avoid the following…" 두 번. Gemini의 instruction-following 가중치가 중복 문장에 의해 왜곡될 가능성.

**제안**:
- `host.ts:51-60`의 `extraBits` collapse 로직 삭제. `extraPrompt`는 사용자가 입력한 raw 값만.
- `negativePrompt`/`faceStrength`/`outfitStrength`는 raw form 필드로만 송출 (이미 송출 중).
- 백엔드는 변경 없음. inline 라벨 + system_instruction이 정상 경로.

**위험**: 이 collapse가 추가된 시점의 백엔드는 raw 필드를 미지원했을 수 있음. 현재 백엔드 코드 기준으로 unsafe 변경은 아니지만 git blame으로 시점 확인 필요.

---

### A2. Step 2 url 백그라운드 dead path

**관찰**:
- `wizard/schema.ts:175` Background discriminated union에 `kind: 'url'` 존재 → store/persistence/provenance 모두 url 모드 통과 가능
- `frontend/src/api/composite.ts:50-67` `buildCompositeBody`는 url 모드에서 어떤 form 필드도 추가 안 함 (코멘트도 자인)
- `modules/composite_generator.py:40` `BackgroundType = Literal["preset","upload","prompt"]` — url 미지원, `_validate_enums`가 reject

**UI 시점 영향**: BackgroundPicker에 url 입력 진입점이 있다면 사용자가 입력 후 422 또는 침묵 실패. (현재 BackgroundPicker UI에 url 모드 노출 여부 — 별도 확인 필요)

**제안 (택1)**:
1. **A2-α (가장 단순)**: BackgroundPicker에서 url 모드 진입점 제거 + `BackgroundSchema`에서 `'url'` variant 삭제. dead path 청소.
2. **A2-β (capability 보존)**: 백엔드에 url 다운로드 어댑터 추가 — `buildCompositeBody`가 url 모드에서 `backgroundUploadPath`로 변환되도록 (백엔드가 url을 fetch해서 임시 파일로 저장 후 upload 경로로 처리). 비대칭 매핑.
3. **A2-γ (프론트 어댑터)**: 프론트 BackgroundPicker가 url 입력을 받으면 즉시 다운로드 → 서버에 업로드 → upload 모드로 전환. 백엔드 변경 없음.

**Open question for review**: url 모드는 사용자가 실제로 사용하는가. UI 진입점 + 사용 빈도로 결정.

---

### A3. `toRenderRequest` dead export

**관찰**: `frontend/src/wizard/api-mappers.ts:190-237`의 `RenderRequest` interface와 `toRenderRequest` 함수는 `subtitle`, `width`, `height` 필드를 반환하지만 어떤 호출처도 없음 (grep 결과 self-reference만 존재). 실제 dispatch는 `frontend/src/api/video.ts:39` `generateVideo`가 별도 경로로 처리.

**제안**: `toRenderRequest` + `RenderRequest` interface 삭제. video.ts `generateVideo`에 인라인된 로직이 단일 truth.

**부수 효과**: subtitle 개념이 wire에 도달 못 함을 명시화. 자막 기능이 향후 필요해지면 별도 plan.

---

### A4. `/api/generate`의 dead Form 파라미터

**관찰**: `app.py:1434-1466`이 받는 Form 파라미터 vs `video.ts:39-111`이 보내는 파라미터:

| 백엔드 수신 가능 | 프론트 송신 | 상태 |
|---|---|---|
| `audio_source` | ✅ (`'upload'` 고정) | OK |
| `host_image_path`, `audio_path`, `resolution`, `playlist_id`, `meta`, `queue_label` | ✅ | OK |
| `script_text`, `voice_id`, `stability`, `similarity_boost`, `style` | ❌ | audio_source='upload'라 backend 무시 |
| `scene_prompt`, `reference_image_paths` | ❌ | Stage 0 Gemini bg 분기(`app.py:538-568`) dead |
| `prompt` (FlashTalk T5 conditioning) | ❌ | `config.FLASHTALK_OPTIONS["default_prompt"]` fallback |
| `seed`, `cpu_offload` | ❌ | backend default |

**제안**:
- `script_text`/`voice_id`/`stability`/`similarity_boost`/`style` Form 파라미터 + `if audio_source == "elevenlabs"` 분기 (`app.py:1493-1527`) 제거. audio_source는 항상 'upload' 모드 — TTS는 Step 3에서 별도 endpoint로 미리 끝남.
- `scene_prompt` + `reference_image_paths` Form 파라미터 + Stage 0 분기(`app.py:538-568`) 제거. composite_generator가 Stage 0의 후속자.
- `prompt`(FlashTalk), `seed`, `cpu_offload`는 capability로 보존하되 Form 파라미터 default를 기본값으로 그대로 두고 frontend는 송신 안 함 (기존 그대로).

**Out of scope**: `/api/generate-conversation` 같은 멀티 에이전트 엔드포인트는 별도 audit (이번 plan은 single-host studio 한정).

---

## 그룹 B — UI ↔ 프롬프트 의미 불투명 (UX)

### B1. Step 1 strength 추상화 격차

**관찰**: 4단계 칩 (`느슨하게/참고만/가깝게/똑같이`)이 0.15/0.45/0.7/0.95에 매핑. 사용자가 "가깝게=0.7"이 4장의 후보 중 어느 정도 강도로 적용됐는지 비교 불가. 후보 4장이 모두 동일 strength로 생성되므로 strength 효과를 사용자가 한 번에 못 봄.

**제안 후보**:
- B1-α: 4장의 후보를 4개 strength로 분산 생성 (0.3/0.5/0.7/0.9). 사용자는 "어느 것이 마음에 드는지"로 선택. 단점: 모드별 자유도 감소.
- B1-β: 칩 hover 시 미니 비교 이미지 노출 (예제 reference + 결과 4장 캐시). 단점: 콘텐츠 production cost.
- B1-γ: 4단계 라벨 유지하되, UI에 **"이 강도가 결과에 어떻게 나타나는지"** 한 줄 설명 (예: "참고만 — 얼굴 윤곽만 따라가요"). 가장 적은 변경.

**Open question**: 사용자 페르소나 — 입문자 위주면 γ, 파워유저면 α.

---

### B2. temperature 기본값 묻힘

**관찰**: Step 1/2 모두 `temperature` 기본 0.7 ("보통"). UI 위치: HostControls.tsx, CompositionControls.tsx에서 변동성 segmented 노출. 처음 진입하는 사용자가 "변동성"을 만지지 않으면 4장의 후보가 비슷한 톤으로 수렴.

**제안 후보**:
- B2-α: 첫 생성에서 4장을 4개 temperature로 분산 (0.4/0.7/0.7/1.0). 두 번째 생성부터 사용자 선택값 사용. 단점: 첫 결과의 일관성 약함.
- B2-β: "변동성" 컨트롤을 step 메인 영역(앞)으로 끌어올리고 first-time tooltip — "낮으면 비슷한 4장, 높으면 다양한 4장이 나와요". 가장 적은 변경.
- B2-γ: 사실 default(0.7)가 합리적이고 사용자가 만질 일이 적음 — 현행 유지.

**Open question**: B2 변경의 비용/효과. 사용자 데이터(temperature 변경 비율)로 결정해야 정확.

---

### B3. Step 3 음성 advanced sliders 미리듣기 부재

**관찰**: `VoiceAdvancedSettings.tsx`의 stability/style/similarity/speed 슬라이더 변경 후 사용자가 결과를 들어보려면 "음성 만들기"를 다시 눌러야 함 → ElevenLabs API 호출 1회 비용 + 대기시간. 슬라이더 변경의 의미를 사용자가 즉시 못 체감.

**제안**:
- B3-α: 짧은 sample script (10자 이내, 예: "안녕하세요 반갑습니다")에 대한 미리듣기 버튼을 advanced 영역에 추가. 슬라이더 변경 시 디바운스 후 자동 호출 (또는 명시적 버튼). ElevenLabs character 비용 절감.
- B3-β: 슬라이더 옆에 정성적 라벨만 추가 ("일정함 80 — 매우 안정적"). 실제 음성은 미리듣기 안 함.

**Out of scope**: ElevenLabs 비용 분석은 별도 spec.

---

### B4. Step 2 direction "1번/2번" 토큰의 wire 매핑

**관찰**: `CompositionControls.tsx`의 direction Textarea에 사용자가 "1번 제품 왼쪽" 식으로 입력. 이 텍스트는 `[5] DIRECTION (한국어 원문)` 블록에 verbatim 들어감. 백엔드 `_build_v2_1`은 ref_images 순서를 `PRODUCT #1, #2, ...`로 라벨링. 즉 "1번"의 의미가 모델에게도 동일하게 전달되는가는 ordinal 매핑 일관성에 의존.

**검증 필요**: ProductList의 number와 백엔드 product_image_paths 순서가 동일한지 확인 (현재 코드는 array 순서를 신뢰).

**제안**: 검증 결과 일치한다면 별도 변경 없음. 일치 안 한다면 direction에 명시적 매핑 (예: "Image 2 (PRODUCT #1, '제품A')") 주입.

---

## 그룹 C — 프롬프트 capability 미활용

### C1. Product name 미수집

**관찰**: `wizard/schema.ts:148-152`의 `Product.name`은 store/provenance에 저장되나 ProductList UI에서 입력 받지 않음. composite 프롬프트도 ordinal `PRODUCT #1, #2`만 사용 → 브랜드/모델명을 모델이 모름.

**제안 후보**:
- C1-α: ProductList에 제품명 입력란 추가. `[1] ROLES` 블록의 `PRODUCT #1` 뒤에 `(브랜드명)` 주입.
- C1-β: 현행 유지. 제품명을 알면 모델이 학습 데이터의 해당 제품 외형을 환각할 위험 (실제 업로드 사진과 다른 제품을 그릴 수 있음).

**Open question**: 모델 행동 — 제품명 주입의 net effect. small experiment로 확인 가능.

---

### C2. 이미지 모드 negativePrompt 부재

**관찰**: `HostInputSchema`의 image variant에 `negativePrompt` 필드 없음. 텍스트 모드에서만 노출 → 이미지 모드 사용자는 "피하고 싶은 것" 표현 불가. 그러나 백엔드 `_build_host_system_instruction`은 mode와 무관하게 negative_prompt를 받음.

**제안**: image variant에 `negativePrompt: z.string()` 필드 추가 + HostReferenceUploader에 텍스트 입력 노출. 매핑은 텍스트 모드와 동일.

**위험 낮음**: schema 추가는 backward-compat (default 빈 문자열).

---

### C3. FlashTalk T5 prompt 미커스터마이즈

**관찰**: 모든 영상이 동일 default prompt 사용 (`config.py:45-53` "calmly speaking, restrained lip movement…"). 사용자가 영상 톤(차분/에너제틱/뉴스앵커풍)을 조정할 슬롯 없음.

**제안 후보**:
- C3-α: Step 3에 "영상 톤" segmented (차분/보통/활기) — 3개 preset prompt로 매핑. /api/generate에 `prompt` Form 송신 활성화.
- C3-β: 현행 유지. lip-sync 품질이 default prompt에 의존하므로 사용자 입력이 망가뜨릴 위험.

**Open question**: 사용자가 톤 조정을 원하는가, 아니면 default가 충분한가.

---

## Out of scope (이번 plan)

- 멀티 에이전트(`/api/generate-conversation`) 매핑
- ElevenLabs voice library curation
- FlashTalk inference 자체 튜닝 (sample_steps, motion_frames 등)
- Result 페이지/Provenance 표시 변경
- Auth/playlist 관련

---

## Decision matrix (review 통과 항목 선별)

| 항목 | 변경 비용 | 영향 | 위험 | priority |
|---|---|---|---|---|
| A1 강도/네거티브 collapse 제거 | 낮 | 모델 행동 개선 | 중 (backend 의존성 검증 필요) | P1 |
| A2 url 백그라운드 정책 결정 | 중 (택1 따라) | 사용자 침묵 실패 차단 | 낮 | P1 |
| A3 toRenderRequest 삭제 | 낮 | 코드 청결 | 매우 낮 | P2 |
| A4 backend dead Form 정리 | 중 | 코드 청결, 보안 surface 감소 | 낮 | P2 |
| B1 strength UI | 낮~중 | 입문자 명확성 | 낮 | P2 |
| B2 temperature 노출 | 낮 | 4장 다양성 | 낮 | P3 |
| B3 advanced 미리듣기 | 중 | UX 체감↑ | 중 (ElevenLabs 비용) | P2 |
| B4 product ordinal 검증 | 매우 낮 | 정확성 | 매우 낮 | P1 |
| C1 product name | 중 | 모델 capability↑/환각 위험 | 중 | P3 (실험 후) |
| C2 image-mode negativePrompt | 낮 | UX 대칭성 | 매우 낮 | P1 |
| C3 FlashTalk prompt 노출 | 중 | 영상 톤 자유도 | 중 (lip-sync 품질) | P3 |

---

## /plan-eng-review 결정 결과 (2026-04-29)

UI-first 원칙: **현재 UI에 노출돼 있는 입력값**의 매핑 정합성만 cleanup. 새 UI 입력 추가는 design-review 영역.

### 채택 (이 PR scope)
- ✅ **A1** — Frontend collapse 제거. `host.ts:51-60` 삭제 + `mapping.ts`의 `strengthToClause` / `negativeToSystemSuffix` 함수 자체 삭제. backend는 그대로 raw 값 처리.
- ✅ **A2** — α 옵션. `BackgroundSchema`에서 `kind:'url'` variant 제거 + UI dead branch 정리 (`BackgroundPicker.tsx:78-81, 141`). UI에 url 입력 없음 확인됨, legacy localStorage 데이터도 없음 (URL 모드는 한 번도 user-facing이 아니었음).
- ✅ **A3** — `RenderRequest` interface + `toRenderRequest` 함수 완전 삭제 (`api-mappers.ts:190-237`). grep 0건 확인.
- ✅ **A4** — `/api/generate`의 ElevenLabs 분기(`app.py:1493-1527`) + Stage 0 분기(`app.py:538-568`) + 9개 unused Form param 제거.

### 회귀 테스트 (자동 채택, Iron Rule)
- `api-mappers.test.ts` — buildHostGenerateBody가 strength/negative를 extraPrompt에 합치지 않는지 단언
- `normalizers.test.ts` — legacy `{source:'url'}` background → INITIAL preset fallback
- `normalizers.test.ts` — 기존 url 관련 케이스 삭제 (line 67-70, 337-338)
- `tests/test_api_video_generate.py` 신규 — `audio_source='elevenlabs'` 거부 + `scene_prompt` 무시

### 이관 (NOT in scope — UI 변경 또는 capability 추가)
- 🔄 **B1 strength UI** → `/plan-design-review`
- 🔄 **B3 advanced 미리듣기** → `/plan-design-review`
- 🔄 **C2 image-mode negativePrompt** → `/plan-design-review` (UI에 없는 새 입력 추가)
- 🔄 **C3 FlashTalk T5 prompt 노출** → `/office-hours` 또는 `/plan-ceo-review` (lip-sync 사전 실험 필요)
- TODOS.md에 통합 메모 1건 추가 (B1+B3+C2+C3 묶음)

### PR 단위 권장
- **PR 1** (A1 + A3): frontend api 정리 — `host.ts`, `mapping.ts`, `api-mappers.ts`
- **PR 2** (A2): schema/migrator 정리 — `schema.ts`, `normalizers.ts`, `BackgroundPicker.tsx`
- **PR 3** (A4): backend cleanup — `app.py`, 신규 `tests/test_api_video_generate.py`

3개 PR로 분리 시 리뷰 친화 + 회귀 시 blast radius 격리.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (cleanup-only PR) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 4 issues: A1/A2/A3/A4 채택, B1/B3/C2/C3 이관 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | recommended for B1/B3/C2/C3 follow-up |
| Outside Voice | `/codex` | Independent 2nd opinion | 0 | — | skipped (cleanup scope, low risk) |

- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED — ready to implement (3 PRs: A1+A3, A2, A4)

