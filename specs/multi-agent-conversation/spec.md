# Multi-Agent Conversation 기능 명세

## 개요

두 명의 AI 쇼호스트가 대화 형식으로 방송하는 멀티 에이전트 영상 생성 기능.
각 에이전트는 고유한 얼굴 이미지, 음성(ElevenLabs), 대사를 가지고 번갈아 대화한다.

## 핵심 요구사항

### 1. 입력
- **모델 이미지 2장**: 각 에이전트의 얼굴 이미지 (업로드 또는 기본값)
- **음성 2개**: 각 에이전트의 ElevenLabs voice_id (음성 목록에서 선택)
- **대화 스크립트**: 턴 기반 대화 형식 (프론트엔드 UI에서 동적 입력)

### 2. 출력
- **단일 합성 영상**: 두 에이전트가 대화하는 완성된 영상 (MP4)
- **레이아웃 옵션**:
  - `split`: 화면 좌우 분할 (뉴스 토론 스타일) — 발언자 하이라이트 테두리
  - `switch`: 발언자 전환 (전체 화면 전환 스타일)
  - `pip`: Picture-in-Picture (메인 발언자 + 서브 화면)

### 3. 엔진
- SoulX-FlashTalk 14B (현재 프로젝트의 주력 엔진)
- ElevenLabs TTS (`eleven_multilingual_v2` 모델, 한국어 최적화)

### 4. 동작 방식

```
프론트엔드에서 에이전트 설정 + 대화 스크립트 JSON 전달
    ↓
dialog_parser.py: JSON → DialogScript (agents + turns) 파싱 및 검증
    ↓
conversation_generator.py: 각 턴별 순차 생성
  ├─ ElevenLabs TTS 생성 (에이전트별 voice_id)
  └─ FlashTalk 립싱크 영상 생성 (에이전트별 얼굴 이미지)
    ↓
conversation_compositor.py: 영상 합성 (레이아웃 적용)
  ├─ split: 좌우 분할 + 발언자 하이라이트
  ├─ switch: 전체 화면 전환
  └─ pip: 메인 + 서브 화면
    ↓
최종 MP4 영상 출력
```

## API 인터페이스

### `POST /api/generate-conversation`

**Content-Type**: `multipart/form-data`

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `dialog_data` | string (JSON) | O | 에이전트 + 대화 턴 데이터 |
| `layout` | string | X | `split` (기본), `switch`, `pip` |
| `prompt` | string | X | FlashTalk 프롬프트 |
| `seed` | int | X | 시드 (기본 9999) |
| `cpu_offload` | bool | X | CPU 오프로드 (기본 true) |
| `resolution` | string | X | 해상도 (기본 `1280x720`) |

**dialog_data JSON 구조**:
```json
{
  "agents": [
    {
      "id": "A",
      "name": "김민수",
      "face_image_path": "uploads/host_xxx.jpg",
      "voice_id": "elevenlabs_voice_id_a"
    },
    {
      "id": "B",
      "name": "이수진",
      "face_image_path": "uploads/host_yyy.jpg",
      "voice_id": "elevenlabs_voice_id_b"
    }
  ],
  "dialog": [
    {"agent": "A", "text": "안녕하세요!"},
    {"agent": "B", "text": "반갑습니다!"}
  ]
}
```

**응답**:
```json
{"task_id": "hex_string", "message": "Conversation video generation started"}
```

**진행 상태**: 기존 `GET /api/progress/{task_id}` SSE 엔드포인트로 턴별 진행률 수신.

**결과 영상**: 기존 `GET /api/videos/{task_id}` 엔드포인트로 다운로드.

## 영상 합성 레이아웃 상세

### Split (좌우 분할)
```
┌──────────┬──────────┐
│          │          │
│  Agent A │  Agent B │
│ (발언중)  │ (정지)    │
│          │          │
└──────────┴──────────┘
```
- 비발언 에이전트는 마지막 프레임 정지 (loop -1)
- 영상/이미지를 대상 영역에 꽉 채움 (crop-to-fill): 여백 없이 스케일 업 후 넘치는 부분만 잘라냄
- ffmpeg `hstack` 필터로 합성
- 각 턴별로 분할 영상 생성 후 `concat demuxer`로 연결

### Switch (전환)
```
┌─────────────────────┐
│                     │
│    현재 발언자       │
│    (전체 화면)       │
│                     │
└─────────────────────┘
```
- 발언자 변경 시 전체 화면 전환
- 각 턴 영상을 출력 해상도에 crop-to-fill 후 `concat demuxer` 연결

### PiP (Picture-in-Picture)
```
┌─────────────────────┐
│                 ┌───┐│
│  메인 발언자     │서브││
│  (전체 화면)     │화면││
│                 └───┘│
└─────────────────────┘
```
- 메인: 발언자 전체 화면 (crop-to-fill)
- 서브: 비발언자 정지 프레임 (우하단 1/4 크기, crop-to-fill, 흰색 테두리)
- ffmpeg `overlay` 필터로 합성
- 턴 변경 시 메인/서브 교체

## 프론트엔드 UI

### ConversationGenerator 컴포넌트
- **좌측 패널 (입력)**:
  - 에이전트 A/B 카드 (이미지 업로드 + ElevenLabs 음성 선택)
  - 대화 스크립트 에디터 (턴 추가/삭제, 에이전트 선택, 텍스트 입력)
  - 레이아웃 3종 선택 (Split/Switch/PiP)
  - 해상도 선택 (448p/480p/720p/1080p)
  - 고급 설정 (프롬프트, 시드, CPU Offload)
  - 대화 영상 생성 버튼
- **우측 패널 (출력)**:
  - **레이아웃 미리보기**: 에이전트 이미지 업로드 시 선택한 레이아웃(Split/Switch/PiP)에 맞춰 실시간 프리뷰 표시 (선택한 해상도 비율 반영, crop-to-fill)
  - SSE 기반 턴별 진행률 표시
  - 에러 표시
  - 완성 영상 재생 + 다운로드

### App.jsx 모드 전환
- 헤더에 "Single Host" / "Multi-Agent 대화" 토글 버튼
- 모드에 따라 VideoGenerator 또는 ConversationGenerator 렌더링

## 향후 확장 요구사항

### 비발언자 자연스러운 처리 (구현 완료)
- 에이전트별 3초 무음 기반 idle 영상을 FlashTalk으로 생성 → compositor에서 반복 재생
- split/pip 레이아웃에서 정지 프레임 대신 자연스러운 움직임 표시

### idle 시선 방향 (구현 완료)
- split 레이아웃에서 왼쪽 호스트는 오른쪽을, 오른쪽 호스트는 왼쪽을 자연스럽게 바라보는 idle 영상
- idle 프롬프트에 시선 방향 지시를 에이전트 위치(좌/우) 기반으로 자동 주입
- 캐시 키에 idle 프롬프트가 포함되므로 방향별 별도 캐시 자동 관리

### idle 자연스러운 움직임 (구현 완료)
- 노이즈 진폭 증가 (0.01→0.05)로 오디오 임베딩 활성화 → 미세 근육 움직임 유도
- idle 전용 프롬프트: 눈 깜빡임, 호흡, 미세 표정 변화, 시선 방향 등 구체적 지시
- FlashTalk의 T5 텍스트 인코더가 모션 의도를 해석 + Wav2Vec2 오디오 임베딩이 프레임별 모션 가이드

### idle 영상 디스크 캐싱 (구현 완료)
- 동일 이미지(sha256 해시)+프롬프트+해상도+seed 조합이면 기존 idle 영상 재사용
- 캐시 키: 이미지 바이너리 해시 + prompt + resolution + seed → sha256
- 저장 위치: `{TEMP_DIR}/idle_cache/{cache_key}.mp4`
- 캐시 히트 시 FlashTalk 호출 스킵 → GPU 시간 절약

### 전환 효과 (구현 완료)
- Switch 레이아웃: xfade + acrossfade 0.3초 크로스페이드 전환
- 향후: 발언자 이름 자막 (drawtext, 한국어 폰트 필요)

### 에이전트별 프롬프트 (구현 완료)
- 에이전트 카드에서 개별 FlashTalk 프롬프트 설정 가능
- 비워두면 공통 프롬프트(고급 설정) 자동 사용

### 에이전트별 TTS 파라미터
- 현재: 모든 에이전트 동일 ElevenLabs 파라미터
- 목표: 에이전트별 stability, similarity_boost, style 개별 설정
- UI: 에이전트 카드에 접이식 음성 파라미터 패널

### 음성 클론 통합
- 현재: Single Host 모드에서만 음성 클론 가능
- 목표: 대화 모드 에이전트 설정에서 직접 음성 클론 + 선택
- UI: 에이전트 카드 내 음성 클론 섹션

### 3인 이상 대화
- 에이전트 동적 추가/삭제 (최대 4인)
- Split: 3~4분할 레이아웃
- PiP: 다중 서브 화면
- API: agents 배열 크기 제한 완화

### SoulX-FlashHead 1.3B 엔진 지원
- FlashHead Lite 모델로 경량 실시간 생성 (RTX 4090에서 96 FPS, 3 concurrent)
- 엔진 선택 옵션 (FlashTalk 14B / FlashHead 1.3B)
- FlashHead 장점: 2캐릭터 동시 로딩 가능, VRAM 효율적

### 대화 스크립트 관리
- 스크립트 저장/불러오기 (JSON 파일 import/export)
- 대화 스크립트 템플릿 (상품 소개, 인터뷰, 토론 등 사전 정의 패턴)
- 대화 자동 생성 (LLM 기반: 주제만 입력하면 대화 스크립트 자동 생성)

### 히스토리 및 작업 관리
- 대화 영상 전용 히스토리 패널 (참여 에이전트, 레이아웃 정보 포함)
- 생성 중 취소 기능 (생성된 턴까지 부분 결과 정리)
- 대화 영상 재편집 (기존 턴 수정 후 해당 턴만 재생성)

### 성능 최적화
- TTS 선행 생성: 비디오 생성 대기 중 다음 턴 TTS 미리 생성
- 동일 에이전트 연속 턴 시 prepare_params 스킵
- 턴별 병렬 합성 (합성 단계에서 ffmpeg 파이프라인 최적화)

## 현재 제약 사항

- 2인 대화만 지원
- 각 턴의 최대 길이: ElevenLabs TTS 생성 가능 범위 내
- 총 대화 길이: 제한 없음 (턴 수 제한 없음)
- 비발언자: 정지 프레임 (마지막 프레임 유지)
- GPU: FlashTalk 14B 기준 A100 80GB에서 순차 생성 (cpu_offload 필수)
- Switch 레이아웃 전환: 하드컷만 지원 (crossfade 미구현)
