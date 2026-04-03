# Background Composition - 구현 계획

> **구현 상태**: Phase 1 + Phase 2 + Phase 3 (Gemini) + Phase 4 (Single Host Gemini) + Phase 5 (비율 보존 + 조명/그림자/투시 개선) 완료 (2026-04-02)
> - `modules/image_compositor.py` — Gemini Image API 기반 합성으로 전환
> - 모드 A (빈 배경): Gemini로 자연스러운 인물 배치 (fallback: rembg+PIL)
> - 모드 B (사람 있는 배경): Gemini로 얼굴 교체 (fallback: InsightFace)
> - 자동 모드 감지 (InsightFace 얼굴 감지 기반)
> - API: `/api/upload/background-image`, `/api/preview/composite`, `/api/preview/composite-together`
> - 프론트엔드: 공통 배경 업로드 + 합성 프리뷰 (Multi-Agent + Single Host 모두 지원)
> - Gemini는 클라우드 API → 로컬 GPU 사용 없음 (얼굴 감지만 로컬)
> - `config.py`에 `load_dotenv()` 추가하여 `.env` 파일의 `GEMINI_API_KEY` 자동 로딩

---

## Phase 1: 빈 배경 합성 (모드 A) — 완료

### 1.1 인물 세그먼테이션 모듈 — 완료
- **도구**: rembg (U2-Net 기반, CPU 동작)
- **파일**: `modules/image_compositor.py` 신규
- **작업**:
  - `remove_background(image_path) -> RGBA Image`: 인물 배경 제거
  - 첫 호출 시 모델 다운로드 (캐싱됨)
  - 결과 RGBA 이미지를 메모리에 반환

### 1.2 배경 합성 로직 — 완료
- **파일**: `modules/image_compositor.py`
- **작업**:
  - `compose_on_background(host_rgba, bg_image, target_size, position, scale) -> RGB Image`
  - 인물 높이를 배경 높이의 `scale`% (기본 70%)로 리사이즈
  - 위치: 하단 중앙 기본, `position` 파라미터로 좌/우 오프셋
  - PIL `alpha_composite()` 또는 `paste(mask=alpha)`로 합성
  - 최종 이미지를 FlashTalk target 해상도에 맞게 resize+crop

### 1.3 API 확장 — 완료
- **파일**: `app.py` 수정
- **작업**:
  - `POST /api/upload/background-image`: 배경 이미지 업로드 엔드포인트
  - `POST /api/preview/composite`: 합성 프리뷰 (호스트+배경 → 미리보기 이미지 반환)
  - `dialog_data` JSON에 에이전트별 `background_image_path` 필드 추가
  - `generate_conversation_task()` 내에서 배경이 있으면 합성 후 agent.face_image 교체

### 1.4 프론트엔드 UI — 완료
- **파일**: `frontend/src/components/ConversationGenerator.jsx`, `.css` 수정
- **작업**:
  - 에이전트 카드에 배경 이미지 업로드 필드 추가
  - 배경 업로드 시 합성 프리뷰 API 호출 → 미리보기 표시
  - Agent 상태에 `background_image_path`, `backgroundPreview` 추가
  - 인물 크기/위치 조정 슬라이더 (선택)

### 1.5 idle 캐시 키 업데이트
- 배경이 달라지면 cond_image가 달라지므로 idle 캐시 키에 영향
- 합성된 이미지의 해시가 캐시 키에 자동으로 포함되므로 별도 작업 불필요

---

## Phase 2: 인물 교체 합성 (모드 B) — 완료

### 2.1 배경 내 사람 감지 — 완료 (InsightFace 얼굴 감지 사용)
- **도구**: MediaPipe Pose 또는 YOLOv8
- **파일**: `modules/image_compositor.py` 확장
- **작업**:
  - `detect_person(bg_image) -> (bbox, keypoints) or None`
  - 사람이 있으면 바운딩 박스와 키포인트 반환
  - 여러 명이면 가장 큰 (메인) 사람 선택

### 2.2 얼굴 교체 (Face Swap) — 완료
- **도구**: InsightFace + inswapper_128.onnx
- **파일**: `modules/image_compositor.py` 확장
- **작업**:
  - `swap_face(source_image, target_image) -> Image`
  - 소스(호스트)의 얼굴을 타겟(배경 속 사람)에 합성
  - InsightFace로 양쪽 얼굴 감지 → inswapper로 교체
  - 결과 이미지를 FlashTalk cond_image로 사용

### 2.3 의상 교체 (향후)
- **도구**: IP-Adapter + ControlNet 또는 Stable Diffusion Inpainting
- **복잡도**: 높음 — 별도 GPU 모델 로딩 필요
- **방안**:
  - 호스트 이미지에서 의상 영역 추출
  - 배경 속 사람의 의상 영역을 인페인팅으로 교체
  - GPU 메모리 관리: FlashTalk 파이프라인 로딩 전에 인페인팅 모델 실행 후 해제

### 2.4 모드 자동 감지 — 완료
- **파일**: `modules/image_compositor.py`
- **작업**:
  - `compose_agent_image(host_image, bg_image, target_size) -> Image`
  - 배경에서 사람 감지 → 있으면 모드 B (얼굴 교체), 없으면 모드 A (빈 배경 합성)
  - 상위 함수에서 모드 분기 없이 호출 가능

---

## Phase 4: Single Host Gemini 배경 생성 — 완료 (2026-04-02)

Multi-Agent 모드에서만 가능했던 Gemini 배경 생성을 Single Host 모드에도 추가.

### 4.1 프론트엔드 UI — 완료
- **파일**: `frontend/src/components/VideoGenerator.jsx`
- **작업**:
  - `scenePrompt`, `refImages`, `compositeLoading`, `compositePreview` 상태 추가
  - `handleRefImageUpload()`: `/api/upload/reference-image`로 참조 이미지 업로드
  - `generateCompositePreview()`: `/api/preview/composite-together`에 호스트 1명으로 프리뷰 생성
  - 배경 생성 (Gemini) UI 섹션: scene prompt textarea + 참조 이미지 업로드 + 프리뷰 생성/초기화 버튼
  - `handleGenerate()`에서 `scene_prompt`, `reference_image_paths`를 FormData에 추가

### 4.2 백엔드 API — 완료
- **파일**: `app.py`
- **작업**:
  - `/api/generate` 엔드포인트에 `scene_prompt`, `reference_image_paths` 파라미터 추가
  - `generate_video_task()`에 Gemini 배경 생성 Stage 0 추가
  - `compose_agents_together(host_image_paths=[단일 호스트], scene_prompt=..., reference_image_paths=...)` 호출
  - 결과 이미지를 FlashTalk의 `cond_image`로 사용

### 4.3 기존 자원 재사용
- `/api/upload/reference-image` — 기존 Multi-Agent용 엔드포인트 공유
- `/api/preview/composite-together` — 호스트 1명으로도 동작 (기존 구현)
- `modules/image_compositor.py`의 `compose_agents_together()` — 1명 호스트 지원

---

## Phase 5: 비율 보존 + 조명/그림자/투시 개선 — 완료 (2026-04-02)

Gemini 합성 후 인물이 세로로 압축되는 문제와 배경-인물 간 조명/그림자/투시 부자연스러움 개선.

### 5.1 인물 비율 보존 — 완료
- **파일**: `modules/image_compositor.py`
- **문제**: Gemini가 반환하는 이미지 비율이 요청한 `target_size`와 다를 때, `Image.resize()`로 강제 리사이즈하면 인물이 세로로 눌리거나 늘어남
- **해결**: `_resize_and_crop()` 함수 추가 — 비율을 유지하면서 리사이즈 후 center crop
  - `_gemini_generate_scene()`: 결과 이미지 리사이즈를 `_resize_and_crop()`으로 교체
  - `compose_agents_together()` 내 single agent 경로: 동일 교체
  - `generate_background_only()`: 동일 교체

### 5.2 Gemini 프롬프트 — 조명/그림자/투시 강화 — 완료
- **파일**: `modules/image_compositor.py` (`_gemini_generate_scene()`)
- **추가된 프롬프트 규칙**:
  - **조명**: 씬의 주 광원 방향에 맞춰 인물에 일관된 조명 적용, 색온도 매칭, 림라이트/역광 추가
  - **그림자**: 바닥에 현실적인 그림자 캐스팅, 광원 거리에 따른 그림자 선명도 조절, 접촉 그림자(ambient occlusion) 적용
  - **투시**: 바닥면의 소실점과 인물 발 위치 일치, 카메라 앵글(시선 높이) 일관성, 주변 오브젝트 대비 인물 스케일 현실성
  - **비율 보존**: 인물의 height-to-width ratio를 절대 압축/늘리지 않도록 명시
- **`generate_background_only()` 프롬프트에도 반영**:
  - 바닥면의 투시감, 광원 반사, 그림자 자연스러운 위치 가이드 추가

---

## 파일 구조

```
modules/
├── image_compositor.py         # 신규: 배경 합성/얼굴 교체 전처리
│   ├── remove_background()     # Phase 1: rembg 배경 제거
│   ├── compose_on_background() # Phase 1: 빈 배경에 인물 합성
│   ├── detect_person()         # Phase 2: 배경 내 사람 감지
│   ├── swap_face()             # Phase 2: 얼굴 교체
│   └── compose_agent_image()   # 통합 엔트리포인트
├── conversation_generator.py   # 수정: 합성 이미지로 agent.face_image 교체
└── dialog_parser.py            # 수정: Agent에 background_image 필드 추가
```

---

## 의존성

| 패키지 | Phase | 용도 | 설치 |
|--------|-------|------|------|
| rembg | 1 | 인물 배경 제거 | `pip install rembg[gpu]` |
| mediapipe | 2 | 사람 감지 | `pip install mediapipe` |
| insightface | 2 | 얼굴 교체 | `pip install insightface` |
| onnxruntime-gpu | 2 | InsightFace 가속 | `pip install onnxruntime-gpu` |

---

## 구현 순서 (추천)

```
Phase 1.1  인물 세그먼테이션 (rembg)
Phase 1.2  빈 배경 합성 로직
Phase 1.3  API 엔드포인트 추가
Phase 1.4  프론트엔드 UI
Phase 1.5  테스트 + idle 캐시 확인
Phase 2.1  사람 감지 (MediaPipe)
Phase 2.2  얼굴 교체 (InsightFace)
Phase 2.3  의상 교체 (향후)
Phase 2.4  모드 자동 감지 통합
```

---

## 리스크

| 리스크 | 영향 | 대응 |
|--------|------|------|
| 합성 이미지 품질 저하 → FlashTalk 생성 품질 저하 | 높음 | 합성 후 블러/페더링으로 경계 자연스럽게 처리 |
| rembg 세그먼테이션 실패 (복잡한 배경) | 중간 | SAM fallback 또는 사용자 수동 마스크 업로드 |
| GPU 메모리 부족 (InsightFace + FlashTalk 동시) | 높음 | 전처리 완료 후 모델 해제, FlashTalk은 이후 로딩 |
| 배경 속 사람 포즈 ≠ 호스트 포즈 → 교체 부자연스러움 | 중간 | 포즈 유사도 경고 또는 모드 A fallback |
