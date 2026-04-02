# Background Composition - 기능 명세

## 개요

사용자가 배경 이미지를 업로드하면, 쇼호스트 이미지와 합성하여 해당 배경에서 말하는 영상을 생성한다.
배경에 사람이 있으면 그 사람을 업로드한 쇼호스트의 얼굴과 의상으로 교체한다.

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

## 사용자 인터페이스

### 프론트엔드 변경
- 공통 배경 이미지 업로드 필드 (에이전트 카드가 아닌 공유 영역)
- 배경 업로드 시 합성 프리뷰 표시 (호스트 + 배경 미리보기)
- 합성 모드 자동 감지 (배경에 사람 있으면 모드 B, 없으면 모드 A)

### 백엔드 API
- `POST /api/upload/background-image` — 배경 이미지 업로드
- `POST /api/preview/composite` — 합성 프리뷰 생성 (Gemini API 호출)
- 기존 `POST /api/generate-conversation` — dialog_data에 배경 이미지 경로 포함

## 데이터 흐름

```
프론트엔드                     백엔드
─────────────────────────────────────────────
호스트 이미지 업로드 ──────→ uploads/host_{id}.png
배경 이미지 업로드   ──────→ uploads/bg_{id}.png
                              │
합성 프리뷰 요청     ──────→ compose_agent_image()
                              ├── InsightFace 얼굴 감지 → 모드 결정
                              ├── Gemini Image API 호출
                              │   ├── 모드 A: "place person in scene" 프롬프트
                              │   └── 모드 B: "replace face" 프롬프트
                              ├── (실패 시) rembg/InsightFace 폴백
                              └──→ 합성 이미지 반환

영상 생성 요청       ──────→ generate_conversation_task()
                              ├── compose_agent_image() (Gemini)
                              ├── 합성 이미지를 agent.face_image로 설정
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

## 제약사항 및 주의

- Gemini API 호출 시 이미지는 1024px 이하로 리사이즈하여 전송 (API 제한)
- API 응답 시간: 수 초~수십 초 소요 가능 (네트워크 의존)
- 합성 이미지 품질이 FlashTalk 생성 영상 품질에 직접 영향
- GPU 메모리: Gemini는 클라우드 API이므로 로컬 GPU 사용 없음 (얼굴 감지만 로컬)
- 멀티 에이전트 대화: 공통 배경 1장 업로드, 각 에이전트에 동일하게 적용
