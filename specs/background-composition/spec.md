# Background Composition - 기능 명세

## 개요

사용자가 배경 이미지를 업로드하거나, 텍스트 프롬프트 + 참조 이미지로 Gemini가 배경을 생성하여,
쇼호스트 이미지와 합성한 영상을 생성한다.
배경에 사람이 있으면 그 사람을 업로드한 쇼호스트의 얼굴과 의상으로 교체한다.

**Single Host / Multi-Agent 모두 지원.**

## 합성 엔진

### Gemini Image API (Primary)
- **모델**: `gemini-3-pro-image-preview` (Nano Banana Pro)
- **방식**: 호스트 이미지 + 배경 이미지 + 텍스트 프롬프트를 Gemini에 전달
- **장점**: 자연스러운 조명, 그림자, 비율 처리; 텍스트 프롬프트로 세밀한 제어
- **API Key**: `.env` 파일의 `GEMINI_API_KEY` 사용

### Fallback (Legacy)
- Gemini API 실패 시 자동으로 기존 방식으로 폴백
- 모드 A: rembg 배경 제거 + PIL 합성
- 모드 B: InsightFace 얼굴 교체

## 동작 모드

### 모드 A: 빈 배경 합성
- 배경 이미지에 사람이 없는 경우
- Gemini에 "이 사람을 이 배경에 자연스럽게 배치" 프롬프트 전달
- 자연스러운 조명, 그림자, 비율 자동 처리

### 모드 B: 인물 교체 합성
- 배경 이미지에 사람이 있는 경우 (InsightFace 얼굴 감지)
- Gemini에 "배경 속 사람의 얼굴을 호스트 얼굴로 교체" 프롬프트 전달
- 포즈, 의상, 배경은 유지하고 얼굴만 자연스럽게 교체

## 동작 모드 C: 텍스트 프롬프트 기반 배경 생성

- 사용자가 scene prompt(텍스트)로 원하는 배경을 설명
- 선택적으로 참조 이미지(상품, 브랜딩 등)를 업로드
- Gemini가 호스트 인물을 유지하면서 설명된 배경에 자연스럽게 배치
- **Single Host, Multi-Agent 모두 동일한 방식으로 동작**

## 사용자 인터페이스

### Multi-Agent 모드 (`ConversationGenerator.jsx`)
- 공통 배경 이미지 업로드 필드 (에이전트 카드가 아닌 공유 영역)
- Scene prompt textarea + 참조 이미지 업로드
- 프리뷰 생성 버튼 → Gemini 합성 이미지 미리보기
- 합성 모드 자동 감지 (배경에 사람 있으면 모드 B, 없으면 모드 A)

### Single Host 모드 (`VideoGenerator.jsx`)
- 호스트 이미지 아래에 "배경 생성 (Gemini)" 섹션
- Scene prompt textarea + 참조 이미지 업로드
- 프리뷰 생성 버튼 → Gemini 합성 이미지 미리보기
- 영상 생성 시 scene_prompt가 있으면 자동으로 Gemini 배경 합성 후 FlashTalk에 전달

### 백엔드 API
- `POST /api/upload/background-image` — 배경 이미지 업로드
- `POST /api/upload/reference-image` — 참조 이미지 업로드 (상품 등)
- `POST /api/preview/composite` — 단일 호스트 합성 프리뷰 (배경 이미지 기반)
- `POST /api/preview/composite-together` — Gemini scene 생성 프리뷰 (Single Host / Multi-Agent 공용)
- `POST /api/generate` — Single Host 영상 생성 (scene_prompt, reference_image_paths 파라미터 추가)
- `POST /api/generate-conversation` — Multi-Agent 영상 생성 (dialog_data에 scene_prompt 포함)

## 데이터 흐름

### Multi-Agent 모드
```
프론트엔드                     백엔드
─────────────────────────────────────────────
호스트 이미지 업로드 ──────→ uploads/host_{id}.png
참조 이미지 업로드   ──────→ uploads/ref_{id}.png
scene prompt 입력
                              │
합성 프리뷰 요청     ──────→ compose_agents_together()
                              ├── rembg 인물 추출 → 흰색 캔버스
                              ├── Gemini Image API (scene prompt + 참조 이미지)
                              └──→ 합성 이미지 반환

영상 생성 요청       ──────→ generate_conversation_task()
                              ├── compose_agents_together() (Gemini)
                              ├── 합성 이미지를 agent.face_image로 설정
                              └── FlashTalk 파이프라인 진입
```

### Single Host 모드
```
프론트엔드                     백엔드
─────────────────────────────────────────────
호스트 이미지 업로드 ──────→ uploads/host_{id}.png
참조 이미지 업로드   ──────→ uploads/ref_{id}.png
scene prompt 입력
                              │
합성 프리뷰 요청     ──────→ compose_agents_together([단일 호스트])
                              ├── rembg 인물 추출 → 흰색 캔버스
                              ├── Gemini Image API (scene prompt + 참조 이미지)
                              └──→ 합성 이미지 반환

영상 생성 요청       ──────→ generate_video_task()
                              ├── compose_agents_together() (Stage 0)
                              ├── 합성 이미지를 host_image로 교체
                              └── FlashTalk 파이프라인 진입
```

## 의존성

```
google-genai         # Gemini Image API (primary)
rembg                # 인물 세그먼테이션 - fallback용
insightface          # 얼굴 감지 + 교체 - 모드 감지 + fallback용
onnxruntime-gpu      # InsightFace 추론 가속
python-dotenv        # .env 파일 로딩
```

## 조명/그림자/투시 품질

Gemini 프롬프트에 다음 규칙을 포함하여 현실적인 합성 품질을 확보:

- **조명**: 씬의 주 광원 방향에 맞춰 인물에 일관된 조명/색온도 적용, 림라이트/역광 반영
- **그림자**: 바닥에 현실적 그림자 캐스팅, 접촉 그림자(ambient occlusion), 광원 거리에 따른 선명도
- **투시**: 바닥면 소실점과 인물 발 위치 일치, 카메라 앵글 일관성, 주변 오브젝트 대비 스케일 현실성
- **비율 보존**: Gemini 결과 이미지를 `_resize_and_crop()`으로 비율 유지 리사이즈 + center crop (강제 resize에 의한 인물 압축/늘어남 방지)

## 제약사항 및 주의

- Gemini API 호출 시 이미지는 1024px 이하로 리사이즈하여 전송 (API 제한)
- API 응답 시간: 수 초~수십 초 소요 가능 (네트워크 의존)
- 합성 이미지 품질이 FlashTalk 생성 영상 품질에 직접 영향
- GPU 메모리: Gemini는 클라우드 API이므로 로컬 GPU 사용 없음 (얼굴 감지만 로컬)
- 멀티 에이전트 대화: 공통 배경 1장 업로드, 각 에이전트에 동일하게 적용
- Single Host 모드: 동일한 `compose_agents_together()` 함수를 호스트 1명으로 호출
