<!-- /autoplan restore point: /opt/home/jack/.gstack/projects/buzzni-SoulX-FlashTalk/main-autoplan-restore-20260421-105046.md -->
# HostStudio UI 이식 + Pipeline V2 통합 마이그레이션 플랜 (v2 revised)

> **상태**: ✅ **결정 확정** — `/autoplan` 1차 리뷰 완료 + 사용자 결정 반영. Phase -1(TDD 스켈레톤) 실행 준비.
> **작성일**: 2026-04-21 (v2: 결정 반영 후 개정)
> **관련 spec**:
> - [`pipeline-v2/plan.md`](../pipeline-v2/plan.md) — 백엔드 Stage 1/2 상세 설계
> - [`model-parameter-audit/TODO.md`](../model-parameter-audit/TODO.md) — Gemini/ElevenLabs 파라미터
> - [`elevenlabs-voice-quality/TODO.md`](../elevenlabs-voice-quality/TODO.md) — TTS v2 → v3
> - [`task-queue/plan.md`](../task-queue/plan.md) — 순차 작업 큐 (DONE)
> - [`background-composition/plan.md`](../background-composition/plan.md) — Gemini 합성 (DONE)

## 1. 목적

Claude Design에서 전달받은 **HostStudio 프로토타입**(`/tmp/hoststudio-design/`)을 프로덕션 UI로 이식하고, 백엔드를 **pipeline-v2**에 맞춰 확장한다. 기존 프론트엔드(`VideoGenerator`, `ConversationGenerator`)는 **마이그레이션 후 삭제**한다. HostStudio가 **유일한** 파이프라인.

## 2. Scope

### In Scope
- ✅ HostStudio 디자인의 3단계 UI 전체 이식 (프로토타입 100% 충실도)
- ✅ `POST /api/host/generate` 신규 엔드포인트 (pipeline-v2 Stage 1)
- ✅ `POST /api/composite/generate` 신규/확장 (pipeline-v2 Stage 2)
- ✅ `GET/POST/DELETE /api/hosts` CRUD (서버 `outputs/hosts/` + localStorage 인덱스)
- ✅ 기존 `/api/generate` (Stage 3 영상) 재활용 + 매핑 레이어
- ✅ **Gemini 모델**: `gemini-3-pro-image-preview` → **`gemini-3.1-flash-image-preview`** 전역 전환 (비용 ~1/5)
- ✅ **ElevenLabs 모델**: `eleven_multilingual_v2` → **`eleven_v3`** 전역 업그레이드 ([breath] 네이티브)
- ✅ 모델 파라미터 패치: `aspect_ratio` 동적, `system_instruction`, `use_speaker_boost`, `language_code`, `speed` 노출
- ✅ 대본 문단 편집 + `[breath]` 자동 삽입 (v3가 네이티브 처리) + 5000자 한도
- ✅ Task queue 연동 (기존 그대로)
- ✅ **업로드 보안 강화**: magic-byte 검증, 크기 제한, filename sanitize, path traversal guard
- ✅ **Feature flags**: `FEATURE_HOSTSTUDIO` (cutover용 1개만). 모델 업그레이드(v3, Flash)는 전역 전환 + 커밋 revert 롤백
- ✅ **Pre-existing 버그 수정**: `app.py:543-551` missing return, `:565` dead return
- ✅ **TDD 스켈레톤** 선행 (Phase -1 신설)

### Out of Scope (V2 이후)
- ❌ 제품 URL 입력 (디자인 대화 2730줄 기준 drop 결정)
- ❌ 배경 URL 입력 (프리셋·업로드·프롬프트로 대체)
- ❌ 계정 시스템 / DB 기반 호스트 저장소 (V2에서 승격)
- ❌ `RenderDashboard.jsx` 완전 신규 디자인 (Phase 5에서 프로토타입 골자 + QueueStatus 결합 수준까지만)
- ❌ 모바일/태블릿 최적화 (데스크톱 only V1, **CSS는 확장 가능한 구조로** 설계)

### Non-Goals
- 🚫 기존 Single Host / Multi-Agent **공존**: **삭제 확정** (마이그레이션 cutover 시점에 제거)
- 🚫 모드 토글: **없음**. HostStudio가 유일한 엔트리 포인트.
- 🚫 디자인의 OKLCH 토큰 + Pretendard 톤다운: **디자인 100% 충실 이식**

## 3. 현재 ↔ 목표 상태

### 3.1 백엔드 엔드포인트

| HostStudio 동작 | 현 상태 | 필요 조치 |
|---|---|---|
| Step1 호스트 생성 | ❌ 없음 | **신규**: `POST /api/host/generate` (Gemini Flash, N=4) |
| Step1 호스트 업로드 (face/outfit/style ref) | ⚠️ `/api/upload/host-image` 1개만 존재 | **확장**: `/api/upload/reference-image` 활용, 타입 구분 필드 추가 |
| Step1 저장된 호스트 관리 | ❌ 없음 | **신규**: `GET/POST/DELETE /api/hosts` — 서버 영속 + 클라이언트 인덱스 |
| Step2 합성 생성 | ⚠️ `/api/preview/composite-together` 존재하지만 구조 다름 | **신규**: `POST /api/composite/generate` (N=4, rembg, direction 전달) |
| Step2 배경 프롬프트 생성 | ✅ `image_compositor.generate_background_only` | Step2 내부 재활용 |
| Step2 제품 rembg 전처리 | ❌ 없음 | **확장**: 업로드 시 자동 처리, `?rembg=false` 토글 |
| Step3 TTS | ✅ `/api/elevenlabs/generate` | **v3 모델로 전환**, 파라미터 확장 |
| Step3 음성 복제 | ✅ `/api/elevenlabs/clone-voice` | v3에서도 유효 |
| Step3 음성 목록 | ✅ `/api/elevenlabs/voices` | 그대로 |
| Final 영상 생성 | ✅ `/api/generate` | 매핑 레이어로 연결 |
| 작업 큐 | ✅ DONE | 그대로 |

### 3.2 프론트엔드 구조 (간결화)

| 삭제 | 신규 |
|---|---|
| `src/components/VideoGenerator.jsx` ❌ | `src/studio/App.jsx` (유일 엔트리) |
| `src/components/ConversationGenerator.jsx` ❌ | `src/studio/Step1Host.jsx`, `Step2Composite.jsx`, `Step3Audio.jsx` |
| `src/App.jsx` 의 mode 토글 ❌ | `src/studio/PreviewPanel.jsx`, `primitives.jsx`, `Icon.jsx` |
| 기존 `App.css` (legacy 스타일) ❌ | `src/studio/styles/tokens.css`, `app.css` (디자인 그대로) |
| | `src/studio/api.js` — **매핑 레이어** (UI state → 백엔드 파라미터) |

- `src/components/QueueStatus.jsx`는 `src/studio/`로 이동 + 스타일 디자인 시스템에 맞게 통일
- `src/App.jsx`는 단순 wrapper로 남고 HostStudio 직접 마운트

## 4. 마이그레이션 단계 (Phase -1 신설, 총 7.5 phase)

### Phase -1 — 테스트 스켈레톤 (TDD 선행) 🆕
**소요**: 1~1.5일
**이유**: Eng 리뷰 1/10 점수 근본 해결. 이후 모든 Phase가 "테스트 unskip → 구현 → 통과" 리듬.

**-1.1 테스트 인프라 세팅**
- [ ] `pyproject.toml` (또는 `pytest.ini`) 추가:
  ```toml
  [tool.pytest.ini_options]
  markers = [
    "phase0: Phase 0 model parameter patches",
    "phase1: Phase 1 host generator",
    "phase2: Phase 2 composite generator",
    "phase3: Phase 3 frontend fidelity",
    "phase4: Phase 4 mapping layer",
    "phase5: Phase 5 render dashboard",
    "phase6: Phase 6 cutover",
  ]
  addopts = "--strict-markers --cov=modules --cov=app --cov-fail-under=60"
  ```
- [ ] `frontend/vitest.config.js` 신규 (`test.environment=jsdom`, `coverage.provider=v8`, 임계 60%)
- [ ] CI workflow: `.github/workflows/test.yml` — pytest + vitest 병렬 실행, skip은 green 처리
- [ ] **coverage floor**: 새 코드 60%, 기존 코드 보존 (regression 방지)

**-1.2 테스트 스켈레톤 파일 생성**
- [ ] Python 테스트 파일 (모두 `@pytest.mark.skip("TDD placeholder - Phase N unskip")`):
  - `tests/test_host_generator.py` (`pytest.mark.phase1`)
  - `tests/test_image_compositor.py` (`pytest.mark.phase0`)
  - `tests/test_elevenlabs_tts.py` (`pytest.mark.phase0`)
  - `tests/test_upload_security.py` (`pytest.mark.phase0`)
  - `tests/test_api_host_generate.py` (`pytest.mark.phase1`)
  - `tests/test_api_composite_generate.py` (`pytest.mark.phase2`)
  - `tests/test_api_hosts.py` (`pytest.mark.phase1`)
  - `tests/test_progress_sse.py` (`pytest.mark.phase4`)
  - `tests/test_voice_pitch.py` (`pytest.mark.phase4` — D2 rubberband)
- [ ] Vitest 테스트 파일: `frontend/src/studio/__tests__/api.test.js` (`describe.skip`)
- [ ] `specs/hoststudio-migration/tests.md` 작성 (전체 테스트 명세서 + unskip 타임라인)

**-1.3 React 19 호환성 spike**
- [ ] 프로토타입 `App.jsx` 1개 컴포넌트를 Vite+React19로 시험 변환 (30분 timeboxed)
- [ ] `createRoot`, `useRef`, `useEffect` 동작 확인
- [ ] 이슈 발견 시 Phase 3 리스크 업데이트

### Phase 0 — 선결 패치 + 모델 업그레이드 (🔴 반드시 선행)
**소요**: 5~6일 (3차 리뷰 반영: security 헬퍼 14 엔드포인트 + 감사로그 + 인증 합산)

**4.0.1 Gemini 전역 전환 + 파라미터**
- [ ] **T-GM1** — `modules/image_compositor.py`의 **두 call site 모두** 교체:
  - `:242` (scene 생성)
  - `:487` (두 번째 사용처 — 3차 리뷰에서 발견)
  - 방식: `GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image-preview"` 상수 (`config.py`), 전역 전환
  - 롤백: 품질 회귀 시 커밋 revert (feature flag 불필요)
- [ ] **T-GM2** — `image_config.aspect_ratio`를 `target_size`에서 **동적 유도** (landscape=16:9, 9:16=9:16). 하드코드 금지.
- [ ] **T-GM3** — `system_instruction` 추가 (Stage 1: 인물 단독 / Stage 2: 전경 보존 + 배경만 수정)
- [ ] **T-GM3b (보안)** — `safety_settings` 명시: 4개 카테고리(HARM_CATEGORY_*) 모두 `BLOCK_MEDIUM_AND_ABOVE`. 프롬프트 인젝션 방어.
- [ ] **T-GM3c (보안)** — 사용자 입력 sanitize (at concat site, not storage):
  - `\n{3,}` → `\n\n` 정규화 (사용자 paragraph 보존, 3+ 연속만 collapse)
  - Delimiter 토큰 strip: ` ``` `, `"""`, `<|...|>`, `---\n` (system_instruction escape 방지)
  - Korean paragraph 보존 필수 — `direction` 필드의 줄바꿈 의미 유지
- [ ] **T-GM4** — `thinking_config.thinking_level="minimal"` (Flash 필수)
- [ ] **Eval harness**: 10샘플 A/B (이전/이후) — Stage 1 "단독 인물" 통과율, Stage 2 identity preservation (face embedding cosine)

**4.0.2 ElevenLabs v3 업그레이드 (전역 전환)**

Legacy 트래픽 0건 (기존 사용자 없음, Phase 6에서 삭제) → 단순 전역 전환. Feature flag 불필요.

- [ ] **T-EL0** — `config.py` ELEVENLABS_OPTIONS.model_id: `eleven_multilingual_v2` → `eleven_v3` (단일 커밋)
- [ ] **T-EL1** — `use_speaker_boost=True` 추가
- [ ] **T-EL2** — `language_code="ko"` 추가
- [ ] **T-EL3** — `generate_speech()`에 `speed: float = 1.0` 파라미터 노출
- [ ] **T-EL4** (v3 신규) — 문자 한도 10k → **5k** 재검증 (HostStudio 5000자 한도와 일치)
- [ ] **T-EL5** (v3 신규) — `[breath]` 토큰 native 처리 확인 (문단 사이 자연 pause 생성)
- [ ] **품질 회귀 테스트**: 5개 voice × 동일 script → v2 vs v3 샘플 청취 비교
- [ ] **롤백 정책**: 품질 회귀 발견 시 **커밋 revert** (feature flag 토글 아님). Phase -1 CI + Phase 0 eval harness가 회귀 검출 gate.

**4.0.3 업로드/경로 보안 강화 (CSO 리뷰 확대 반영)**

🚨 **Critical 2건 선결**:

- [ ] **공용 헬퍼 `_safe_upload_path(p: str) -> str`**: `realpath(p)`가 `UPLOADS_DIR` 또는 `OUTPUTS_DIR` prefix 확인. 실패 시 `HTTPException(400)`.
- [ ] **모든 path-accepting 엔드포인트에 적용** (현재 + 신규):
  - 업로드 4종: `/api/upload/host-image`, `/upload/background-image`, `/upload/reference-image`, `/upload/reference-audio`
  - 생성 body 필드: `/api/generate`의 `host_image_path`, `audio_path`, `/api/preview/composite*`의 `bg_image_path`, `host_image_paths[]`, `reference_image_paths[]`
  - 신규 Phase 1-2: `/api/host/generate`의 `faceRefPath`, `outfitRefPath`, `styleRefPath`; `/api/composite/generate`의 `hostImagePath`, `productImagePaths[]`, `backgroundUploadPath`
- [ ] **`/api/files/{filename:path}` 정비** (`app.py:1255-1269`):
  - `PROJECT_ROOT` fallback **완전 제거** (현재 CRITICAL 취약점)
  - **허용 디렉토리**: `UPLOADS_DIR`, `OUTPUTS_DIR`, **`EXAMPLES_DIR`** (demo 자산 보존용 — `examples/woman.png` 등)
  - realpath 체크 3개 경로 모두에 대해 수행
- [ ] **이미지 업로드 검증**:
  - Pillow `Image.verify()` magic-byte
  - **20MB 크기 제한**: (a) `Content-Length` 헤더 pre-check → 413 즉시 거부, (b) handler 내 chunked read 누적 카운터 `while chunk := await file.read(CHUNK): total += len(chunk); if total > 20_000_000: raise HTTPException(413)` — 두 방어선 모두
- [ ] **오디오 업로드 검증** (누락되었던 부분):
  - `/api/upload/audio`, `/upload/reference-audio`, `/api/elevenlabs/clone-voice`
  - `python-magic` 또는 `ffprobe`로 magic-byte 검증 (오디오/비디오 파일만 허용)
- [ ] **파일명 정책**: 이미 UUID primary 사용 중 (`app.py:155-162`). 원본 파일명 disk path에서 완전 제거 (UUID만 유지). `secure_filename`은 unicode 깨지므로 사용 금지.
- [ ] **ffmpeg SSRF 방지**: 검증된 local path만 전달, `-protocol_whitelist file` 플래그 추가

**4.0.4 Pre-existing 버그 수정**
- [ ] `app.py:543-551` `upload_background_image` — 누락된 `return` 추가
- [ ] `app.py:563-565` `upload_reference_image` — 중복 `return` 제거 (dead code)
- [ ] `conversation_compositor`/`image_compositor`에서 `target_h`/`target_w` 변수명 명확화 + 주석

**4.0.5 인프라**
- [ ] **`FEATURE_HOSTSTUDIO` flag 1개**만 도입 (`config.py` 상수): Phase 6 cutover rollback용. 모델 전환은 commit revert.
- [ ] **CORS 명시 origin 리스트 확정** (`재검토` 아님):
  - dev: `["http://localhost:5173", "http://localhost:8001"]`
  - prod: 환경변수 `CORS_ORIGINS` (콤마 구분)
  - `allow_credentials=True` 유지 시 `*` 금지 (브라우저가 거부)
- [ ] **`.gitignore` 확장**: `.env`, `.env.*`, `*.key`, `*.pem` 추가 (현재 누락)
- [ ] **브랜치 보호 규칙** 문서화: `main` 푸시 금지, PR 1 리뷰 + 그린 CI 필수
- [ ] **SCA (Supply Chain)**: Phase -1 CI에 `pip-audit` + `npm audit --audit-level=high` 추가

**4.0.6 인증 baseline (신규 — CSO 리뷰 P0, 3차 리뷰로 확정)**

🚨 **두 방어선 동시 적용** (defense in depth):

- [ ] **기본**: `uvicorn --host 127.0.0.1` 바인딩 (현재 `0.0.0.0` — `app.py:1279`). 외부 접근 차단.
- [ ] **선택적 X-API-Key 미들웨어**: 환경변수 `REQUIRE_API_KEY=1` 설정 시 활성화. `REQUIRE_API_KEY` env + `API_KEY` env 모두 검증. 미매칭 시 401.
- [ ] 공유 secret은 `.env`에 저장 (git ignored)
- [ ] Phase 1의 `/api/hosts/*` 배포 전까지 반드시 적용
- [ ] **V2 목표**: 실제 세션/계정 시스템 (DB 필요, out of scope)

**4.0.7 감사 로그 (신규 — CSO 리뷰 Medium)**

- [ ] 모든 mutating 엔드포인트에 구조화 audit log (JSON lines → `logs/audit.log`):
  - 필드 **allowlist** (PII 제외): `timestamp`, `ip` (해시), `endpoint`, `method`, `status_code`, `duration_ms`, `task_id` (있으면)
  - **금지 필드**: body params (filename, voice_id, script_text 등 PII 가능성)
  - 대상: `/api/generate`, `/api/host/generate`, `/api/composite/generate`, `/api/hosts/save`, `/api/hosts/{id} DELETE`, `/api/upload/*`
- [ ] **음성 샘플 보존 정책** (GDPR 고려): `/api/elevenlabs/clone-voice` 업로드 → voice_id 발급 후 **24h 내 자동 삭제**

### Phase 1 — 백엔드 Stage 1 (호스트 생성)
**소요**: 2~3일 (기존 1-2일 → 확장: 보안·테스트 포함)

- [ ] `modules/host_generator.py` 신규:
  ```python
  async def generate_host_candidates(
      mode: Literal["text", "face-outfit", "style-ref"],
      text_prompt: str | None,
      face_ref_path: str | None,
      outfit_ref_path: str | None,
      style_ref_path: str | None,
      extra_prompt: str | None,
      n: int = 4,
      timeout_per_call: float = 45.0,
      min_success: int = 2,
  ) -> list[str]:
      """
      Returns list of generated image paths. Partial success OK.
      Raises if < min_success succeed.
      """
  ```
  - 내부: `asyncio.gather(*tasks, return_exceptions=True)` + `wait_for` timeout per task
  - `min_success=2` 정책: 2장 이상 성공 시 반환, 미만 시 예외
  - Gemini 싱글톤 동시성 가드 (semaphore=8)

- [ ] `app.py` 엔드포인트:
  ```
  POST /api/host/generate
    Body: { mode, prompt?, faceRefPath?, outfitRefPath?, styleRefPath?, extraPrompt?, n=4 }
    → { candidates: [{ seed, path, url }], partial: bool, errors?: [str] }
  ```
  - **작업 큐 사용 안 함** (Gemini는 외부, pipeline_lock 불필요). 다만 Gemini 싱글톤 release_models() 경합 guard 필요

- [ ] 호스트 저장소 (서버 영속 + 클라이언트 인덱스):
  - `POST /api/hosts/save` { imageUrl, name, meta } → `outputs/hosts/saved/{uuid}.png` + `.json` 메타
  - `GET /api/hosts` → 저장 목록
  - `DELETE /api/hosts/{id}`
  - 클라이언트 localStorage에는 `id` 인덱스만 보관 (썸네일 data URI 금지, 5MB 한도 관리)

### Phase 2 — 백엔드 Stage 2 (합성)
**소요**: 2~3일 (기존 1일 → 확장: rembg·번역·테스트)

- [ ] `POST /api/composite/generate`:
  ```
  Body: {
    hostImagePath, productImagePaths[], 
    backgroundType: "preset"|"upload"|"prompt",
    backgroundPresetId?, backgroundUploadPath?, backgroundPrompt?,
    direction: str (한국어),
    shot: "closeup"|"bust"|"medium"|"full",
    angle: "eye"|"low"|"high",
    n: int = 4
  }
  → { candidates: [...], partial, errors? }
  ```
- [ ] 제품 rembg 자동 처리 (기본 ON, `?rembg=false` 토글)
- [ ] `direction` 한국어 → 영어 프롬프트 변환 (pipeline-v2 §882-895 참고)
- [ ] N=4 parallel with return_exceptions=True, min_success=2

### Phase 3 — 프론트엔드 디자인 이식 (JSX → Vite)
**소요**: 2~3일

- [ ] `src/studio/` 디렉토리 생성
- [ ] 프로토타입 7개 JSX를 Vite ES 모듈로 변환:
  - Babel standalone 제거, `import/export` 추가
  - React 19 호환 검증 (**Phase -1 즉시** 30분 spike 선행 권장)
- [ ] CSS 이식: 707줄 `app.css` + `tokens.css` → `src/studio/styles/`
  - 모든 선택자에 `.studio-root` 프리픽스 (ESLint 규칙으로 강제)
  - Pretendard, JetBrains Mono는 `index.html`에서 CDN 로드 (FOUT 회피)
  - OKLCH fallback: Safari <15.4 대비 `@supports` 블록 (V2 경고만, V1 허용)
- [ ] **Port Fidelity Checklist**: 아래 인터랙션이 100% 작동하는지 체크
  - [ ] `hl-textarea` 미러 하이라이트 (`1번`, `2번` 매칭)
  - [ ] `insertProductRef` 커서 위치 유지
  - [ ] `breath-divider` 시각 (v3 [breath] 동작과 연결)
  - [ ] 생성 후 auto-scroll
  - [ ] `preset-tile` hover/selected 상태
  - [ ] 제품 drag 재정렬
  - [ ] Density (넓게/좁게) 토글
  - [ ] Step index localStorage 자동 저장
  - [ ] 업로드 교체/삭제 (swap 아이콘)
  - [ ] Skeleton 로딩 (그러나 25초+ 대응으로 **진행률 UI 추가** — §6 state matrix 참조)

**확장성 — 모바일 대비 CSS 구조**
- [ ] `grid-template-columns: minmax(520px, 1fr) minmax(420px, 560px)` → `clamp(320px, 50vw, 600px) clamp(320px, 50vw, 560px)` 등 상대 단위 사용
- [ ] `@media (max-width: 960px) { /* TODO V2: 세로 스택 */ }` 주석만 남김
- [ ] **960-1280px 범위**: `data-density="compact"` 자동 힌트 (V1 포함, 저렴)

**Prototype-only 코드 제거 (Phase 3 필수)**
- [ ] **postMessage density handshake 제거** (`App.jsx:40-61`의 `__activate_edit_mode`, `__edit_mode_set_keys`) — 프로덕션에 parent frame 없음
- [ ] 대체: 우상단 Tweaks 아이콘 버튼 → 기존 panel, localStorage 영속 (`showhost_density` 키)

### Phase 4 — 프론트 ↔ 백엔드 연동 (매핑 레이어)
**소요**: 3~4일 (기존 2-3일 → 매핑 복잡도 + 피치 후처리 포함)

- [ ] `src/studio/api.js` — **단일 책임 어댑터**:
  - UI state → 백엔드 body 변환 (§5.1.1, §5.1.2 포함)
  - 파일 업로드 choreography (File → path)
  - 에러 핸들링 (Gemini 429, ElevenLabs 401/429, 네트워크 timeout)
  - **Resolution helper**: `parse_resolution(str) → (w, h)` 공용 파서 (backend + frontend 양쪽)
  - 전체 매핑은 §5 파라미터 매핑표 참조
- [ ] Step1: `POST /api/host/generate` → candidates 표시
- [ ] Step2: `POST /api/composite/generate` → candidates 표시
- [ ] Step3: 
  - "음성 만들기" 버튼 → `POST /api/elevenlabs/generate` (`model_id="eleven_v3"`, 전체 문단 결합본 1회)
  - 그 후 미리듣기 플레이어 활성화 (편집 중 재생 없음)
- [ ] Final: `POST /api/generate` 큐 등록 + SSE 구독
- [ ] **`voice.pitch` 후처리 파이프라인** (§5.3.1):
  - 백엔드 `modules/video_postprocess.py` 신규
  - `generate_video_task` 완료 후 pitch ≠ 0이면 ffmpeg rubberband 적용
  - 테스트 `test_voice_pitch` unskip
- [ ] 에러 UX (§6 State Matrix + §6.5 카피) 구현

### Phase 5 — Render 화면 + Queue 통합 (⬆️ 확장)
**소요**: 2일 (기존 0.5일 → 2일로 상향, 감정적 climax)

- [ ] 프로토타입 `RenderDashboard.jsx` 뼈대 완성:
  - 큐 포지션 표시 ("앞에 2개 작업이 있어요")
  - 경과 시간 / 예상 남은 시간
  - SSE 진행 단계 시각화 (composite → voice gen → video render)
  - 첫 프레임 preview (가능 시)
- [ ] 완료 화면:
  - autoplay video player
  - `[다운로드]` `[공유]` `[영상 하나 더 만들기]` CTA
  - 작은 축하 애니메이션 (confetti 수준, 비용 0)
- [ ] `QueueStatus` 컴포넌트 `src/studio/QueueStatus.jsx`로 이관 + 스타일 통일

### Phase 6 — Cutover + Legacy 삭제
**소요**: 1일 (기존 0.5-1일)

- [ ] `FEATURE_HOSTSTUDIO` 기본 ON
- [ ] `src/App.jsx`를 HostStudio 직접 마운트로 교체 (mode 토글 제거)
- [ ] **삭제**: `src/components/VideoGenerator.jsx`, `ConversationGenerator.jsx`, 기존 App.css
- [ ] `/qa` 스킬로 풀스택 dogfood (3 시나리오: 화장품, 음식, 가구)
- [ ] 스크린샷 비교: 프로토타입 vs 구현 (UI fidelity ≥95%)

### 총 예산
**약 18~24.5일** (1차 6-10일 → Eng 리뷰 15-20일 → CSO+Design 17-22일 → 3차 리뷰 현실화)

| Phase | 소요 | 비고 |
|---|---|---|
| -1 | 1~1.5d | TDD 스켈레톤 + 인프라 + React 19 spike |
| 0 | **5~6d** | 보안 헬퍼 14 엔드포인트 + 모델 2개 전환 + 인증 + 감사로그 + 버그 + feature flags |
| 1 | 2~3d | 호스트 생성 + 저장소 CRUD |
| 2 | 2~3d | 합성 + rembg + ko→en 번역 |
| 3 | 2~3d | JSX 이식 + CSS 스코프 (707줄) + a11y |
| 4 | 3~4d | 매핑 레이어 + pitch 후처리 + 에러 UX |
| 5 | 2d | Render 화면 + Queue 통합 |
| 6 | 1~2d | Legacy 삭제 + QA |

---

## 5. 파라미터 매핑표 (디자인 → 백엔드, **UI는 유지, 레이어가 어댑트**)

### 5.1 Step 1 (Host)

| 디자인 state | 매핑 레이어 처리 | 백엔드 파라미터 |
|---|---|---|
| `host.mode='text'` | 1:1 전달 | `mode="text"` + `prompt` |
| `host.mode='image'` + faceRef + outfitRef | File → 업로드 → path | `mode="face-outfit"` + `faceRefPath` + `outfitRefPath` |
| `host.mode='image'` + faceRef only | File 업로드 | `mode="style-ref"` + `styleRefPath=faceRefPath` |
| `host.prompt` | 1:1 | `prompt` |
| `host.negativePrompt` | ✅ **UI 유지** — 아래 §5.1.1 규칙으로 변환 | Gemini `system_instruction`에 병합 |
| `host.builder.{성별,연령대,분위기,옷차림}` | 프리셋 값 한→영 테이블 (고정 dict) | `prompt`에 접미사 결합 |
| `host.faceStrength` (0~1) | ✅ **UI 유지** — 아래 §5.1.2 threshold 표로 변환 | `prompt` 또는 `system_instruction`에 반영 |
| `host.outfitStrength` (0~1) | 동일 방식 (§5.1.2) | 동일 |
| `host.extraPrompt` | 1:1 | `extraPrompt` (prompt 말미) |
| `host.selectedSeed` | 클라이언트 전용 | — (선택된 `path` → `state.host.imageUrl`) |

**원칙**: 프로토타입의 모든 UI 컨트롤을 100% 보존. 매핑 레이어가 "백엔드가 직접 지원하지 않는 필드"를 프롬프트 문자열/시스템 인스트럭션으로 변환.

#### 5.1.1 `negativePrompt` 변환 규칙
- 입력: 사용자가 쓴 한국어 자유 텍스트 (예: "안경 안 쓴 모습, 배경 없음")
- 변환: **한→영 LLM 번역 하지 않음**. 그대로 system_instruction 말미에 합침:
  ```
  system_instruction += f"\n\nAvoid the following in the output: {host.negativePrompt}"
  ```
- 이유: Gemini 3 Pro/Flash는 한국어 부정 지시를 충분히 이해. 번역 단계는 latency·cost 추가 + 번역 오류 위험
- 빈 문자열이면 접미사 전체 생략
- 테스트: `test_mapping_negative_prompt_appends_to_system_instruction`

#### 5.1.2 `faceStrength`/`outfitStrength` Threshold 표
| 값 범위 | 변환 문구 (system_instruction 접미사) |
|---|---|
| 0.0 ~ 0.3 | "Take only loose inspiration from the reference {face/outfit}; prioritize the text description." |
| 0.3 ~ 0.6 | "Use the reference {face/outfit} as a general style guide." |
| 0.6 ~ 0.85 | "Preserve the key features of the reference {face/outfit} closely." |
| 0.85 ~ 1.0 | "Match the reference {face/outfit} as exactly as possible." |

- 기본값: 0.7 (디자인 prototype과 일치)
- 두 값을 각각 적용 (face + outfit 별도 문구)
- 테스트: `test_mapping_strength_boundary_thresholds` (0.29, 0.30, 0.59, 0.60, 0.84, 0.85, 0.99, 1.00)

### 5.2 Step 2 (Composite)

| 디자인 state | 매핑 처리 | 백엔드 |
|---|---|---|
| `host.imageUrl` | 1단계 결과 자동 연결 | `hostImagePath` |
| `products[].url` (blob) | File → 업로드 | `productImagePaths` |
| `products[].source='url'` + `urlInput` | **UI 숨김** (V2 기능) | (해당 없음) |
| `background.source='preset'` + `preset` | 1:1 | `backgroundType="preset"` + `backgroundPresetId` |
| `background.source='upload'` | File 업로드 | `backgroundType="upload"` + `backgroundUploadPath` |
| `background.source='prompt'` | 1:1 | `backgroundType="prompt"` + `backgroundPrompt` |
| `background.source='url'` | **UI 숨김** (V2) | — |
| `composition.direction` | 한국어 그대로 전달 (백엔드가 영어 번역) | `direction` |
| `composition.shot`/`angle` | enum 1:1 | `shot`/`angle` |

### 5.3 Step 3 (Voice + Resolution)

| 디자인 state | 매핑 처리 | 백엔드 |
|---|---|---|
| `voice.source='tts'` | 1:1 | `audio_source="elevenlabs"` (v3) |
| `voice.source='clone'` | 2단계: clone-voice → voice_id 획득 | 동일 |
| `voice.source='upload'` | File 업로드, **[breath] UI 숨김** | `audio_source="upload"` + `audio_path` |
| `voice.voiceId` | 1:1 | `voice_id` |
| `voice.paragraphs[]` (tts/clone 만) | `paragraphs.join(' [breath] ')` (v3가 native 처리) | `script_text` |
| `voice.stability`/`style`/`similarity` | 1:1 | `stability`/`style`/`similarity_boost` |
| `voice.speed` | 1:1 | `speed` (T-EL3 후 지원) |
| `voice.pitch` | ✅ **UI 유지** — §5.3.1 ffmpeg 후처리 (Phase 4 task) | (최종 영상 mux 단계) |
| `resolution.{key,width,height}` | portrait: `"${height}x${width}"` (H-first) / landscape: `"${width}x${height}"` | `resolution` 문자열 |

🚨 **해상도 포맷**: 기존 백엔드가 `"HxW"` 이름이지만 변수 `target_h, target_w` 순서가 일관되지 않음. 매핑 레이어는 `(width, height)` 튜플로 받아 프로덕션 convention에 맞춰 반환. 단위 테스트 필수 (landscape + portrait 양쪽 케이스).

#### 5.3.1 `voice.pitch` ffmpeg 후처리 (Phase 4)

**적용 지점**: FlashTalk 렌더가 끝난 후 최종 MP4에 **오디오 트랙만 pitch shift** 적용. FlashTalk에 들어가는 TTS 입력은 수정하지 않음 (입모양 동기화 보존).

**구현**:
- `modules/video_postprocess.py` 신규 (또는 기존 `conversation_compositor` 확장):
  ```python
  def apply_pitch_shift(input_mp4: str, semitones: float, output_mp4: str):
      # ffmpeg rubberband 필터 (libbrubberband 필수)
      subprocess.run([
          "ffmpeg", "-y", "-i", input_mp4,
          "-c:v", "copy",
          "-af", f"rubberband=pitch={2**(semitones/12):.6f}",
          output_mp4,
      ], check=True)
  ```
- `pitch == 0`이면 후처리 스킵 (빈 ffmpeg 호출 방지)
- **사전 체크**: `ffmpeg -filters | grep rubberband` — Phase -1에서 검증. 없으면 `ffmpeg` 재빌드 or `asetrate+atempo` 폴백
- 적용 타이밍: `generate_video_task` 완료 → `apply_pitch_shift` → 히스토리에 후처리본 저장
- 테스트 (Phase 4): `test_voice_pitch::test_rubberband_filter_applied`, `test_voice_pitch::test_zero_pitch_skips_ffmpeg`

### 5.4 `[breath]` 처리 (v3 전역 적용)

- **tts/clone 모드**: 클라이언트에서 `paragraphs.join(' [breath] ')` → 백엔드는 그대로 v3에 전송 → v3가 문단 사이 자연스러운 숨표 native 삽입
- **upload 모드**: `[breath]` UI 전체 숨김 (breath-divider, 문자 카운터 차감 모두 적용 안 함). 업로드 오디오를 그대로 사용.
- 5000자 한도: `[breath]` 토큰 포함 전체 길이 (v3 문자 한도와 일치)

---

## 6. State Matrix (Design 리뷰 반영) 🆕

**3 surfaces × 6 states** = 18 cells.

| State | Step 1 (호스트 생성) | Step 2 (합성) | Step 3 (음성) |
|---|---|---|---|
| **idle** | "어떤 모습의 쇼호스트를 원하세요?" 폼 | 제품/배경 폼, 합성 버튼 비활성 | 음성 선택, 대본 입력, 만들기 버튼 |
| **validating** | 버튼 disabled + helper text | 동일 | 동일 |
| **generating** | **진행률 바** + "약 20초 소요" + 4장 skeleton | 동일 구조 | 음성 생성: "약 10초" + spinner |
| **streaming** (가능한 경우) | 완성된 후보부터 하나씩 fade-in | 동일 | — |
| **partial-success** | "3/4 생성됨 — 다시 시도" 버튼 | 동일 | N/A (single result) |
| **error** | 한국어 에러 카피 + [다시 시도] 버튼 (카피는 §6.5 참조) | 동일 | 동일 |
| **success** | 선택 가능 그리드 + [다음 단계] 활성 | 동일 | 플레이어 + [영상 만들기] |

### 6.2 a11y Tier-1 baseline (V1 필수 — D15)

현재 prototype의 custom Slider/Segmented/Chip은 키보드·스크린리더 전면 실패. KWCAG 2.1 위반 리스크. Phase 3에서 반드시 구현 (**Tier-1 = axe-core pass**):

- **Slider** (`primitives.jsx:33-68`): `role="slider"`, `aria-valuemin/max/now`, `onKeyDown` (←/→ = step, Home/End = min/max, PageUp/Down = 10× step)
- **Segmented**: `role="tablist"` + 자식 `role="tab"` + `aria-selected`
- **Chip** (토글형): `aria-pressed={on}`
- **preset-tile** (후보 카드): `role="radio"` within `role="radiogroup"` aria-label="후보 선택"
- **Icon-only 버튼** 전부: `aria-label` 한국어 추가 (`voice-play`, `product-drag`, `trash` 등)
- **Step pills**: 활성 step에 `aria-current="step"`
- **결과 카드 출현**: `aria-live="polite"` + "후보 4장 준비됐어요" 음성 안내
- **Focus visible**: 전역 `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`
- **테스트**: axe-core in Vitest (`frontend/src/studio/__tests__/a11y.test.js`) — Phase 3 P0

**Tier-2 a11y (V1.1 이후 — D15)**: contrast(WCAG AA OKLCH 토큰 검증), color-only 선택 상태 보완, focus trap, skip link, page title/`<h1>` 업데이트. V1에서는 아웃오브스코프.

### 6.3 장시간 생성 대기 UX (20s+ — Design 리뷰 P0)

Gemini Flash 실제 레이턴시 15-25s × 2 step = 누적 30-50s. Prototype mock(1.4s)와 100배 차이 → **설계 필수**:

- **진행률 바**: 시간 기반 easeOut (20s 예상, 15s까지 90% 도달)
- **회전 팁** (3s마다): `["더 좋은 결과를 위해 생성 중...", "곧 4개 후보가 나와요", "이 과정은 평균 20초 걸려요"]`
- **첫 후보 스트리밍**: 완성된 순서대로 fade-in. 4장 동시 대기 금지.
- **20s 초과**: "평소보다 오래 걸리고 있어요 — 잠시만요" 보조 텍스트
- **취소 버튼**: 생성 중 언제든 Cancel → server-side asyncio.gather cancel
- **예상 남은 시간**: SSE로 서버 실제 진행 상황 반영 (Phase 5와 연계)

### 6.4 Progressive Disclosure 불변 (Design 리뷰 D14)

**고급 옵션은 반드시 `<details>` 또는 collapse 내 유지. 기본 펼침 금지.**
- `negativePrompt` (`Step1Host.jsx:186-191`) — `<details>` 유지
- `faceStrength`/`outfitStrength` — 참조 업로드 시에만 노출 (`Step1Host.jsx:228-237`)
- `stability`/`similarity`/`style` (`Step3Audio.jsx:223-239`) — "대부분 그대로 두셔도 괜찮아요" 접힘

### 6.5 에러 카피 (한국어, 초안 — 사용자 검수 필요)

| 원인 | 카피 |
|---|---|
| Gemini 429 quota | "지금은 많이 붐벼요. 1분 후 다시 시도해주세요." |
| Gemini network timeout | "생성이 오래 걸리고 있어요. 다시 시도하시겠어요?" |
| Gemini 모두 실패 (N=4 중 0 성공) | "이미지를 만들지 못했어요. 설명을 조금 바꿔서 다시 해보세요." |
| ElevenLabs 401 | "음성 서비스 연결에 문제가 있어요. 관리자에게 문의해주세요." |
| ElevenLabs 429 | "오늘 음성 생성 한도를 거의 다 썼어요. 잠시 후 다시 시도해주세요." |
| Upload 파일 크기 초과 | "파일이 너무 커요 (최대 20MB). 더 작은 파일을 써주세요." |
| Upload 파일 형식 오류 | "이미지 파일만 올릴 수 있어요 (JPG, PNG, WebP)." |
| FlashTalk queue 막힘 | "앞에 N개의 영상이 만들어지고 있어요. 약 M분 후 시작됩니다." |
| SSE 연결 끊김 | "연결이 끊겼어요. 진행 상황을 불러올게요..." + 재연결 시도 |

---

## 7. TDD 전략 🆕

### 리듬
```
1. Phase -1: 모든 테스트 파일 스켈레톤 생성 (전부 .skip)
2. 각 Phase 시작:
   a. 해당 Phase의 테스트 unskip
   b. 테스트 실행 → 전부 실패 확인
   c. 구현 → 테스트 통과
   d. 리팩토링
3. Phase 완료 조건 = 해당 테스트 all pass + 기존 테스트 회귀 없음
```

### 우선순위 (P0 = 반드시, P1 = 권장)

**Phase 0 테스트 unskip**
- P0: `test_image_compositor::test_aspect_ratio_derived_from_target_size` (landscape + portrait)
- P0: `test_image_compositor::test_system_instruction_set`
- P0: `test_elevenlabs_tts::test_speaker_boost_enabled`
- P0: `test_elevenlabs_tts::test_language_code_ko`
- P0: `test_elevenlabs_tts::test_model_v3`
- P0: `test_upload_security::test_magic_byte_check`
- P0: `test_upload_security::test_size_limit_20mb`
- P0: `test_upload_security::test_path_traversal_rejected`

**Phase 1 테스트 unskip**
- P0: `test_host_generator::test_happy_path_returns_4_paths` (mocked Gemini)
- P0: `test_host_generator::test_partial_failure_returns_min_2` (1 fail, 3 success → returns 3)
- P0: `test_host_generator::test_all_fail_raises`
- P0: `test_host_generator::test_timeout_enforced`
- P0: `test_api_host_generate::test_post_returns_candidates`
- P0: `test_api_hosts::test_save_list_delete_roundtrip`

**Phase 2 테스트 unskip**
- P0: `test_api_composite_generate::test_rembg_default_on`
- P0: `test_api_composite_generate::test_rembg_toggle_off`
- P0: `test_api_composite_generate::test_korean_direction_preserved`

**Phase 3 테스트 unskip**
- P0: `api.test.js::test_host_mode_text_mapping`
- P0: `api.test.js::test_host_mode_face_outfit_mapping`
- P0: `api.test.js::test_resolution_portrait_to_HxW`
- P0: `api.test.js::test_resolution_landscape_preserved`
- P0: `api.test.js::test_breath_join`
- P0: `api.test.js::test_script_5000_limit_including_breath`
- P0: `api.test.js::test_upload_mode_skips_breath`

**Phase 5 E2E**
- P1: `e2e/hoststudio.spec::test_full_flow_cosmetics`
- P1: `e2e/hoststudio.spec::test_error_retry`

---

## 8. 리스크 레지스터 (revised)

| # | 리스크 | 영향 | 완화 |
|---|---|---|---|
| R1 | Gemini Flash **품질 회귀** (Pro 대비) | 🎨 | Phase 0 eval harness 10샘플 A/B (단, N=10은 통계적으로 얇음); 품질 미달 시 **커밋 revert**로 Pro 복귀 |
| R2 | Babel CDN → Vite JSX 파싱 에러 | ⏱ | Phase 3 전 30분 spike; 파일 단위 빌드 검증 |
| R3 | React 18→19 호환성 | ⏱ | Phase -1에서 prototype 1개 component sample 실험 |
| R4 | ElevenLabs v3 **음성 품질 회귀** (v2 대비) | 🎨 | Phase 0 5 voice × 1 script 청취 비교; 기존 voice_id 호환성 확인 |
| R5 | v3의 5000자 한도 변화가 기존 ConversationGenerator 영향 (→ 삭제 예정이니 무관, cutover 순서 주의) | 🐛 | Phase 6에서 legacy 제거 후 영향 없음 |
| R6 | 해상도 HxW ↔ WxH 혼동 | 🐛 | 매핑 레이어 단위 테스트 (landscape+portrait 둘 다), 백엔드 변수명 정리 |
| R7 | 제품 rembg 실패 (음식·인테리어) | 🎨 | `?rembg=false` 토글 노출, UI에서 "배경 유지" 옵션 |
| R8 | localStorage 5MB 한도 (호스트 저장소) | ⚠️ | 서버 영속화 + 클라이언트는 ID 인덱스만 (data URI 금지) |
| R9 | Gemini `release_models()` 동시성 race | 🐛 | semaphore로 동시 호출 제한, release 시점 조정 |
| R10 | `asyncio.gather` 1개 실패 시 sibling cancel | 🐛 | 항상 `return_exceptions=True` + min_success 정책 |
| R11 | Pipeline-v2 spec 드리프트 | ⏱ | 이 plan이 pipeline-v2의 **구현 spec** 역할 (병합 대신 cross-reference) |
| R12 | OKLCH Safari <15.4 미지원 | 🎨 | `@supports (color: oklch(...))` 폴백; V1은 경고만 |
| R13 | Gemini 비용 블로업 (rage-click) | 💰 | 서버 debounce (동일 입력 hash 60s 캐시), UI 버튼 cooldown |

---

## 9. 결정 이력 (closed)

| # | 항목 | 결정 | 근거 |
|---|---|---|---|
| D1 | `negativePrompt`/`strength` UI | **유지** | 디자인 100% 충실. 매핑 레이어가 프롬프트 문자열로 변환 |
| D2 | `voice.pitch` | **유지 + ffmpeg 후처리** | 표준 기능 보존, 렌더 후 rubberband 적용 |
| D3 | `[breath]` 처리 | **v3 업그레이드** | v3 네이티브 지원, 이미 voice-quality TODO에 계획됨 |
| D4 | 미리듣기 스코프 | **"음성 만들기" 버튼으로만** | 프로토타입이 이미 이 방식, 추가 UX 불필요 |
| D5 | Legacy 모드 | **삭제 확정** | 사용자 없음, coexist 의미 없음 |
| D6 | default mode | **해당 없음** | 모드 토글 자체 제거 |
| D7 | 호스트 저장소 | **서버 `hosts/` + localStorage 인덱스** | pipeline-v2 I2와 일관 |
| D8 | pipeline-v2 spec 병합 | **cross-reference 유지** | 이 plan이 구현 spec 역할, pipeline-v2는 백엔드 설계 상세 |
| D9 | Gemini 모델 | **Flash로 다운그레이드** | Pro 대비 ~1/5 비용, N=4 유지 가능 |
| D10 | 모바일 | **데스크톱 only V1** | 단, CSS 확장 가능한 구조로 작성 |
| D11 | TDD | **Phase -1 선행** | Eng 리뷰 1/10 근본 해결 |
| D12 | CORS | **명시 origin 리스트** (dev+prod env) | CSO 리뷰, `*` + credentials 조합 거부 |
| D13 | 인증 baseline | **127.0.0.1 bind + 선택적 X-API-Key** | Defense in depth, 3차 리뷰 확정 |
| D14 | Progressive disclosure | **불변 조항** (`<details>` 유지, 기본 펼침 금지) | 디자인 리뷰, 프로토타입 UX 보존 |
| D15 | a11y 스코프 | **Tier-1 V1 (axe-core pass) + Tier-2 V1.1** | 3차 리뷰, 현실 accessibility는 contrast/skip-link 추가 필요 |

---

## 10. 성공 기준 (revised)

- [ ] HostStudio UI 디자인 충실도 ≥95% (스크린샷 비교)
- [ ] 3단계 플로우 end-to-end 3 시나리오(화장품·음식·가구) MP4 생성 성공
- [ ] `/api/host/generate` N=4 parallel 동작 (min_success=2, timeout=45s)
- [ ] `/api/composite/generate` rembg 기본 ON, 토글 OFF 동작
- [ ] Gemini 호출 `aspect_ratio` 동적 (landscape 기존 기능 보존, portrait 9:16)
- [ ] Gemini Flash로 호출 (품질 회귀 시 커밋 revert로 Pro 복귀)
- [ ] ElevenLabs v3 기본 사용, `[breath]` 문단 사이 자연 pause 청취 확인
- [ ] 업로드 보안: magic-byte/size/path traversal 거부 테스트 통과
- [ ] 테스트 커버리지: Phase 0-5 P0 테스트 100% pass
- [ ] `FEATURE_HOSTSTUDIO` flag로 Phase 6 cutover rollback 가능 (모델 전환은 git revert)
- [ ] Legacy 모드 cutover 후 제거 완료
- [ ] `/qa` 스킬 health score ≥ 7/10
- [ ] 호스트 저장: 서버 재시작 + 브라우저 localStorage 초기화 후에도 재사용 가능

---

## 11. 참고 리소스

- 디자인 번들: `/tmp/hoststudio-design/create-ai-showhost-video/`
- 디자인 채팅 전문: `.../chats/chat1.md` (2859줄)
- 프로토타입: `.../project/HostStudio.html`, `src/*.jsx` (7개), `styles/{tokens,app}.css`
- 백엔드 코드: `app.py`, `modules/image_compositor.py`, `elevenlabs_tts.py`, `host_generator.py` (신규)
- 관련 spec: `pipeline-v2/`, `model-parameter-audit/`, `elevenlabs-voice-quality/`

## 12. 다음 액션

1. ✅ **revised plan 2차 재검토 완료** — APPROVED WITH MINOR (Phase -1 착수 가능)
2. **Phase -1 (TDD 스켈레톤 + 인프라) 즉시 실행** 가능
3. Phase -1 완료 후, Phase 0 착수 전 아래 5개 확인:
   - [x] A: D2 pitch 작업 Phase 4에 명시 (§5.3.1)
   - [x] B: v3 call-site gating (§4.0.2 T-EL0)
   - [x] C: negativePrompt/strength threshold 표 (§5.1.1, §5.1.2)
   - [x] D: Phase 0 3-4d 재산정 (§4)
   - [x] E: TDD 인프라 (pytest markers, coverage 60%, CI) (Phase -1 §-1.1)
4. 순차적으로 Phase 0 → 6 진행
5. Phase 3 완료 시 `/plan-design-review`로 UI fidelity 검증
6. Phase 6 cutover 후 `/qa` + `/ship`

## 13. Non-blocking 개선 (Phase 6 cutover 전 권장)
- [x] ~~`/api/hosts/*` 오너십/인증 모델~~ → **Phase 0 §4.0.6으로 승격** (P0)
- [ ] `outputs/hosts/` LRU 정책 (디스크 grow 방지)
- [ ] Rate limit / debounce 구현 (R13의 60s hash 캐시)
- [ ] `/api/host/generate-one-more` 엔드포인트 (pipeline-v2에 있지만 drop 여부 명시)
- [ ] Visual regression 테스트 하네스 (Playwright screenshot diff) — Phase 3 승인 조건으로 승격 권장
- [ ] 첫 방문 onboarding (3-step overlay 또는 "샘플로 체험하기")
- [ ] "이 호스트로 다른 제품 만들기" 재사용 플로우 (Phase 5 완료 화면 CTA)

---

## GSTACK REVIEW REPORT (v2 — 2차 autoplan + CSO + Design 재리뷰)

### v1 → v2 점수 변화 (요약)

| 차원 | v1 | v2 | Δ | v2.2 반영 예상 |
|---|---|---|---|---|
| 테스트 전략 | 1 | 7 | **+6** | 7.5 (P0 유지) |
| 에러 UX | 2 | 7 | +5 | 7.5 (§6.3 대기 UX 추가) |
| **보안** | 2 | 6.5 | +4.5 | **8+** (CSO Critical 2건 반영) |
| **a11y** | 2 | 2 | 0 | **6** (§6.2 baseline 신규) |
| 배포 리스크 | 4 | 6.5 | +2.5 | 7 (auth + audit log) |
| 디자인 충실도 | 5 | 7.5 | +2.5 | 8 (postMessage 제거, 대기 UX) |
| 아키텍처 | 6 | 7 | +1 | 7.5 (prompt sanitize) |

### v2.2 추가 보완 (CSO + Design P0)

**CSO Critical 2건** (반영 완료):
1. `/api/files` `PROJECT_ROOT` fallback 제거 (§4.0.3)
2. Body 필드 path traversal 범위 확대 (§4.0.3, 14개 엔드포인트/필드 열거)

**CSO High 3건** (반영 완료):
- CORS 명시 origin 리스트 확정 (§4.0.5)
- `/api/hosts/*` 인증 baseline (§4.0.6)
- 스트림 중 20MB 크기 제한 (§4.0.3)

**CSO Medium 4건** (반영 완료):
- Prompt injection: safety_settings + input sanitize (§4.0.1 T-GM3b/c)
- 오디오 magic-byte (§4.0.3)
- Audit log (§4.0.7)
- SCA in CI, .gitignore, branch protection (§4.0.5)

**Design P0 4건** (반영 완료):
- a11y baseline §6.2 (axe-core test 포함)
- 20s wait UX §6.3
- Progressive disclosure 불변 §6.4
- postMessage 제거 (Phase 3)

### 최종 상태 (v2.3 — 3차 리뷰 반영 후)

**APPROVED WITH MINOR → v2.3에서 APPROVED.** Phase -1 즉시 착수 가능.

v2.3 패치 (3차 리뷰 7개 fix):
1. ✅ `image_compositor.py` 두 call site 모두 (T-GM1 확장)
2. ✅ `/api/files` `EXAMPLES_DIR` 허용 (demo 자산 보존)
3. ✅ Phase 0 5-6d 재산정 (총 19-24d)
4. ✅ 20MB 크기 제한 Content-Length + chunked 두 방어선
5. ✅ T-GM3c `\n\n` 보존, `\n{3,}` collapse만
6. ✅ `[breath]` 처리 명확화 (v3 전역 전환 — v2.4에서 추가 단순화)
7. ✅ 인증 baseline bind+X-API-Key 동시 적용
8. ✅ D12/D13/D14/D15 §9에 추가
9. ✅ 감사 로그 PII allowlist + clone-voice 24h TTL

**최종 점수 (v2.3)**:
- 아키텍처 7.5 / 테스트 7.5 / **보안 8** / **a11y 6** / 에러 UX 7.5 / 배포 7 / 디자인 8
- Phase -1 readiness: **9/10**
- 보안: 🟢 (Critical 해소, PII 보호)
- 디자인: 🟢 (a11y Tier-1 + 20s 대기 UX)
- 테스트: 🟢 (TDD + SCA + axe-core + eval harness)
- 배포: 🟢 (feature flags + audit + 인증 2중 + rollback)

**Ship 준비 완료.**

---

## GSTACK REVIEW REPORT (v1 — 1차 autoplan 결과)

> 아래는 revised 이전 v1 plan에 대한 리뷰 결과입니다. Decision Audit Trail은 v2에서 대부분 resolved.

### Phase 1 — CEO Voices Consensus (v1)

| Dimension | Score | Status |
|---|---|---|
| Premises valid | 4/10 | ⚠️ (v2에서 해소) |
| Right problem to solve | 5/10 | ⚠️ |
| Scope calibration | 4/10 | 🔴 → v2: 15-20일 현실화 |
| Alternatives explored | 3/10 | 🔴 |
| Competitive risks covered | 3/10 | 🔴 |
| 6-month trajectory sound | 5/10 | ⚠️ |

**Overall CEO v1: 4/10.** Source: `subagent-only` (Codex unavailable).

### Phase 2 — Design Litmus Scorecard (v1)

| Dimension | Score | v2 조치 |
|---|---|---|
| Visual hierarchy | 7/10 | Port fidelity checklist 추가 |
| State coverage | 3/10 | §6 State Matrix 신규 |
| Interaction affordance | 5/10 | Port fidelity checklist 명시 |
| Error UX | 2/10 | §6.5 에러 카피 초안 |
| Accessibility | 2/10 | V2로 명시 이관 |
| Responsive strategy | 2/10 | 데스크톱 only + 확장 가능 CSS |
| Design system coherence | 4/10 | Legacy 삭제로 일원화 |

**Overall Design v1: 3.6/10 (dim) / 5.4/10 (composite).**

### Phase 3 — Eng Voices Consensus (v1)

| Dimension | Score | v2 조치 |
|---|---|---|
| Architecture sound | 6/10 | singleton guard, semaphore 추가 |
| Test coverage sufficient | 1/10 | Phase -1 TDD 신설 |
| Performance risks addressed | 4/10 | timeout, min_success, semaphore 명시 |
| Security threats covered | 2/10 | Phase 0에 보안 강화 포함 |
| Error paths handled | 3/10 | §6 state matrix + 에러 카피 |
| Deployment risk manageable | 4/10 | Feature flags 도입 |

**Overall Eng v1: 3.3/10 → v2 목표: 7+/10.**

### Decision Audit Trail (v1, 대부분 v2에서 resolved)

v1의 Decision Audit Trail 전체 목록은 git 이력으로 복구 가능 (Restore point: `~/.gstack/projects/buzzni-SoulX-FlashTalk/main-autoplan-restore-20260421-105046.md`). v2 결정은 §9 Resolved 결정 이력 참조.

### Deferred to TODOS.md

- 제품 URL 입력 (V2)
- 배경 URL 입력 (V2)
- DB 기반 호스트 저장소 (V2)
- 모바일/태블릿 최적화 (V2)
- OKLCH Safari <15.4 폴백 완전 지원 (V2)
- `RenderDashboard.jsx` 완전 커스텀 디자인 (V2+)
