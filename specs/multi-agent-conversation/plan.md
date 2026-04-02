# Multi-Agent Conversation - 구현 계획

> **구현 상태**: Phase 2 완료 (2026-03-31)
> - Phase 1: 전체 파이프라인 구현 완료: 파서 → 생성기 → 합성기 → API → 프론트엔드
> - Phase 2: 영상 품질 개선 완료: idle 영상 생성, crossfade 전환, 에이전트별 프롬프트

---

## Phase 1: FlashTalk 기반 MVP (완료)

### 1.1 대화 스크립트 파서 모듈 — 완료
- **파일**: `modules/dialog_parser.py`
- **구현 내용**:
  - `Agent` 데이터 클래스: id, name, face_image, voice_id
  - `DialogTurn` 데이터 클래스: agent_id, text
  - `DialogScript` 데이터 클래스: agents dict, turns list, `validate()` 메서드
  - `parse_dialog_json()`: 프론트엔드 JSON → DialogScript 변환

### 1.2 멀티 에이전트 생성기 — 완료
- **파일**: `modules/conversation_generator.py`
- **구현 내용**:
  - `generate_turn_audio()`: 턴별 ElevenLabs TTS 생성 (에이전트별 voice_id)
  - `generate_turn_video()`: 턴별 FlashTalk 립싱크 영상 생성 (stream 모드)
    - 에이전트 얼굴 이미지로 pipeline.prepare_params() 호출
    - 오디오 청크별 순차 생성 + ffmpeg 오디오 머지
  - `generate_conversation()`: 전체 대화 순차 생성 + progress_callback 지원
    - 반환: `[(agent_id, video_path, audio_path), ...]`

### 1.3 영상 합성기 (Compositor) — 완료
- **파일**: `modules/conversation_compositor.py`
- **구현 내용**:
  - `composite_split()`: 좌우 분할 — hstack
  - `composite_switch()`: 전체 화면 전환 — crop-to-fill + concat
  - `composite_pip()`: PiP — overlay 필터 (우하단 1/4 크기 서브 화면)
  - `composite_conversation()`: 메인 진입점 (layout 파라미터로 분기)
  - 비발언자: 첫 출연 프레임 → 턴마다 마지막 프레임으로 업데이트 (정지 프레임)
  - 스케일링 방식: crop-to-fill (scale increase + crop) — 여백 없이 대상 영역을 꽉 채우고 넘치는 부분만 잘라냄 (모든 레이아웃 공통)
  - `_concat_videos()`: ffmpeg concat demuxer로 턴별 영상 연결
  - 유틸: `get_video_duration()`, `get_last_frame()`

### 1.4 API 통합 — 완료
- **파일**: `app.py` 수정
- **구현 내용**:
  - `POST /api/generate-conversation` 엔드포인트
    - `dialog_data` (JSON string), `layout`, `prompt`, `seed`, `cpu_offload`, `resolution` 파라미터
    - 입력 검증 (에이전트 2명 이상, 턴 1개 이상)
  - `generate_conversation_task()` 비동기 백그라운드 태스크
    - pipeline_lock 획득 → 파이프라인 로드 → 턴별 생성 → 합성 → 히스토리 기록
    - 기존 SSE 진행률 시스템 재사용 (`update_task`, `create_task`)
    - 기존 비디오 다운로드/히스토리 시스템 재사용

### 1.5 프론트엔드 UI — 완료
- **파일**: `frontend/src/components/ConversationGenerator.jsx` + `ConversationGenerator.css`
- **구현 내용**:
  - 에이전트 A/B 카드 UI (이미지 업로드 + ElevenLabs 음성 선택)
  - 턴 기반 대화 스크립트 에디터 (동적 추가/삭제, 에이전트 전환)
  - 레이아웃 3종 선택 UI (Split/Switch/PiP)
  - 해상도 4종 선택 (448p/480p/720p/1080p)
  - 고급 설정 (프롬프트/시드/CPU Offload)
  - 레이아웃 미리보기: 에이전트 이미지 업로드 시 선택 레이아웃에 맞춘 실시간 프리뷰 (Split/Switch/PiP)
  - SSE 진행률 + 에러 표시 + 비디오 재생/다운로드

- **파일**: `frontend/src/App.jsx` + `App.css` 수정
- **구현 내용**:
  - "Single Host" / "Multi-Agent 대화" 모드 토글 버튼 (헤더)
  - 모드에 따라 VideoGenerator 또는 ConversationGenerator 렌더링

### 1.6 Spec 문서 — 완료
- **파일**: `specs/multi-agent-conversation/spec.md`
- **파일**: `specs/multi-agent-conversation/plan.md` (이 문서)

---

## 파일 구조 (생성/수정된 파일)

```
SoulX-FlashTalk/
├── app.py                                          # 수정: /api/generate-conversation 추가
├── modules/
│   ├── dialog_parser.py                            # 신규: 대화 스크립트 파서
│   ├── conversation_generator.py                   # 신규: 턴별 TTS + 비디오 생성
│   └── conversation_compositor.py                  # 신규: 레이아웃 합성 (split/switch/pip)
├── frontend/src/
│   ├── App.jsx                                     # 수정: 모드 토글 추가
│   ├── App.css                                     # 수정: 모드 토글 스타일
│   └── components/
│       ├── ConversationGenerator.jsx               # 신규: 대화 생성 UI
│       └── ConversationGenerator.css               # 신규: 대화 생성 스타일
└── specs/multi-agent-conversation/
    ├── spec.md                                     # 기능 명세
    └── plan.md                                     # 구현 계획 + 진행 상황
```

---

## Phase 2: 영상 품질 개선 (완료)

> **완료일**: 2026-03-31

### 2.1 비발언자 idle 영상 생성 — 완료
- **구현 방식**: 에이전트별 3초 무음 WAV → FlashTalk으로 idle 영상 생성 → compositor에서 `-stream_loop -1`로 반복
- **파일**: `modules/conversation_generator.py` 수정
- **구현 내용**:
  - `generate_silence_audio()`: ffmpeg로 무음 WAV 생성
  - `generate_conversation()`에 `layout` 파라미터 추가, split/pip일 때만 idle 생성
  - 에이전트별 1회만 생성 (세션 내 캐싱) → 생성 시간 최소화 (턴당 2배 → 시작 시 +2회)
  - compositor에서 `_get_inactive_input()` 헬퍼로 idle 영상 또는 정지 프레임 분기

### 2.1.1 idle 영상 디스크 캐싱 — 완료
- **구현 방식**: 이미지 바이너리 + prompt + resolution + seed → sha256 해시 → `{TEMP_DIR}/idle_cache/{hash}.mp4`
- **파일**: `modules/conversation_generator.py` 수정
- **구현 내용**:
  - `_compute_idle_cache_key()`: 이미지 파일을 8KB 청크 단위로 sha256 해시 + prompt/resolution/seed 포함
  - `_get_cached_idle()`: 캐시 파일 존재 + 크기 > 0 확인
  - `_save_idle_to_cache()`: 생성된 idle 영상을 캐시 디렉토리에 복사
  - `generate_conversation()` 내 idle 생성 루프에서 캐시 조회 → hit면 FlashTalk 스킵
  - progress 메시지에 캐시 히트 여부 표시 ("idle 영상 캐시 사용" / "idle 영상 생성 중...")
- **효과**: 동일 이미지+파라미터 조합으로 반복 생성 시 idle 생성 시간 0초
- **향후**: 캐시 만료 정책 (LRU/TTL) 추가 가능

### 2.1.2 idle 영상 시선 방향 프롬프트 — 완료
- **현재**: idle 영상이 발화 프롬프트와 동일 → 비발언자가 정면만 응시하여 부자연스러움
- **목표**: split 레이아웃에서 왼쪽 호스트는 오른쪽을 향해, 오른쪽 호스트는 왼쪽을 향해 자연스럽게 시선 이동
- **구현 방식**: idle 영상 생성 시 에이전트 위치(좌/우)에 따라 시선 방향 프롬프트를 자동 주입
  - 왼쪽 에이전트 (agent_a): `"{base_prompt}. The person occasionally looks to the right, as if listening to someone beside them."`
  - 오른쪽 에이전트 (agent_b): `"{base_prompt}. The person occasionally looks to the left, as if listening to someone beside them."`
  - PiP 레이아웃: 메인은 정면, 서브는 정면 (방향 무관)
- **파일**: `modules/conversation_generator.py` 수정
- **작업**:
  - `generate_conversation()` 내 idle 생성 루프에서 에이전트 순서(첫 번째/두 번째) 기반으로 idle 프롬프트 생성
  - 캐시 키에 idle 프롬프트가 포함되므로 방향별로 별도 캐시 자동 생성
  - split 레이아웃에서만 방향 프롬프트 적용, pip/기타는 기존 동작 유지
- **구현 내용**:
  - `generate_conversation()` 내 idle 루프에서 `enumerate`로 에이전트 순서(idx) 확인
  - `idx == 0` (왼쪽): `"...occasionally looks to the right, as if listening to someone beside them."`
  - `idx == 1` (오른쪽): `"...occasionally looks to the left, as if listening to someone beside them."`
  - PiP 레이아웃은 방향 프롬프트 미적용 (기존 동작 유지)
  - idle 프롬프트가 캐시 키에 포함되므로 방향별 캐시 자동 분리 (충돌 없음)
- **주의**: FlashTalk 모델이 프롬프트의 시선 방향 지시를 얼마나 잘 따르는지 실제 테스트 필요. 효과 미미 시 프롬프트 문구 조정

### 2.1.3 idle 영상 자연스러운 움직임 강화 — 완료
- **문제**: 핑크 노이즈 진폭 0.01이 너무 낮아 오디오 임베딩이 거의 0 → 정지에 가까운 영상
- **원인 분석** (FlashTalk 아키텍처):
  - 오디오: Wav2Vec2 → AudioProjModel → 프레임당 32개 cross-attention 토큰 (residual 방식)
  - 프롬프트: T5 텍스트 인코더 → CLIP 시각 특징과 concat → 의미적 모션 가이드
  - `sample_shift`: 디퓨전 샘플링 시 모션 양 제어 (높을수록 움직임 증가)
- **개선 내용**:
  1. 노이즈 진폭 0.01 → 0.05로 증가 (오디오 임베딩 활성화)
  2. idle 프롬프트를 구체적으로 강화 (눈 깜빡임, 호흡, 미세 표정 변화 명시)
  3. idle 생성 시 `sample_shift`를 기본값보다 높게 설정 가능하도록 파라미터화
- **파일**: `modules/conversation_generator.py` 수정
- **캐시**: 프롬프트/노이즈 변경으로 캐시 키가 달라지므로 기존 캐시와 충돌 없음

### 2.2 전환 효과 개선 — 완료
- **구현 방식**: ffmpeg `xfade` + `acrossfade` 필터 체인
- **파일**: `modules/conversation_compositor.py` 수정
- **구현 내용**:
  - `_concat_with_crossfade()`: N개 영상의 비디오+오디오 크로스페이드 연결
  - xfade offset 자동 계산 (cumulative duration 기반)
  - crossfade duration이 클립 길이 초과 시 자동 조정
  - Switch 레이아웃에서 기본 0.3초 crossfade 적용
  - **미구현 (향후)**: 발언자 이름 자막 (drawtext) — 한국어 폰트 의존성으로 별도 진행

### 2.3 에이전트별 프롬프트 지원 — 완료
- **파일**: `modules/dialog_parser.py`, `modules/conversation_generator.py`, `app.py`, 프론트엔드
- **구현 내용**:
  - Agent 데이터 클래스에 `prompt: str = ""` 필드 추가
  - `parse_dialog_json()`에서 에이전트별 prompt 파싱
  - `generate_conversation()`에서 `agent.prompt`이 있으면 에이전트별 프롬프트 사용, 없으면 공통 프롬프트 fallback
  - 프론트엔드 에이전트 카드에 프롬프트 textarea 추가 (placeholder: "비워두면 공통 프롬프트 사용")
  - dialog_data JSON에 에이전트별 prompt 포함

---

## Phase 3: 프론트엔드 UX 개선 (미구현)

> **우선순위**: 중간 — 사용 편의성 대폭 향상

### 3.1 에이전트별 ElevenLabs 파라미터
- **현재**: 모든 에이전트 동일 ElevenLabs 기본값
- **목표**: 에이전트 카드에 접이식 음성 파라미터 패널
- **파일**: `frontend/src/components/ConversationGenerator.jsx` 수정
- **작업**:
  - Agent 상태에 stability, similarity_boost, style 필드 추가
  - 에이전트 카드에 슬라이더 UI (details/summary로 접이식)
  - API: dialog_data JSON에 에이전트별 TTS 파라미터 포함
  - 백엔드: generate_turn_audio()에서 에이전트별 파라미터 사용

### 3.2 음성 클론 통합
- **현재**: Single Host 모드에서만 음성 클론 가능
- **목표**: 에이전트 카드 내에서 직접 음성 클론 + 즉시 선택
- **파일**: `frontend/src/components/ConversationGenerator.jsx` 수정
- **작업**:
  - 에이전트 카드에 음성 클론 섹션 (참조 음성 업로드 + 이름 입력 + 클론 버튼)
  - 클론 완료 시 자동으로 해당 에이전트의 voice_id 설정

### 3.3 레이아웃 미리보기 — 완료 (해상도 비율 반영 개선)
- **현재**: 에이전트 이미지 업로드 시 우측 패널에 실제 해상도 비율 기반 레이아웃 프리뷰 표시
- **구현 내용**:
  - 에이전트 이미지 1장 이상 업로드 시 placeholder 대신 레이아웃 미리보기 렌더링
  - Split: 좌우 분할 (crop-to-fill), 하단에 에이전트 이름 오버레이
  - Switch: 첫 번째 에이전트 전체 화면 (crop-to-fill)
  - PiP: 메인 전체 화면 + 우하단 서브 화면 (28% 크기, 흰색 테두리)
  - 선택 해상도 기반 비율 프리뷰 프레임 (해상도 형식: HxW → aspect-ratio: W/H)
  - 해상도 변경 시 프리뷰 프레임 비율 자동 업데이트
  - 레이아웃/이미지 변경 시 실시간 업데이트
  - 해상도 라벨 표시 (예: "1280x720")
  - 선택한 해상도 안내 텍스트 표시

### 3.4 대화 스크립트 관리
- **목표**: 스크립트 저장/불러오기 + 템플릿
- **작업**:
  - JSON 파일 export/import 버튼
  - 사전 정의 템플릿 (상품 소개, 인터뷰, 토론 등)
  - 최근 사용한 스크립트 로컬 저장 (localStorage)

### 3.5 히스토리 패널
- **현재**: 대화 영상 히스토리 없음 (Single Host 히스토리만 존재)
- **목표**: 대화 영상 전용 히스토리 (참여 에이전트, 레이아웃, 턴 수 정보 포함)
- **파일**: `frontend/src/components/ConversationGenerator.jsx` 수정, `app.py` 수정
- **작업**:
  - 히스토리 API에 conversation 타입 필터 추가
  - 히스토리 항목에 에이전트 이름, 레이아웃, 턴 수 표시
  - 토글로 입력폼 ↔ 히스토리 전환

### 3.6 생성 중 취소 기능
- **현재**: 생성 시작하면 완료까지 대기만 가능
- **목표**: 취소 버튼으로 진행 중인 생성 중단
- **작업**:
  - 백엔드: task cancellation 메커니즘 (cancel flag 체크)
  - 프론트엔드: 진행률 바에 취소 버튼
  - 취소 시 생성된 턴까지의 temp 파일 정리

---

## Phase 4: 확장 기능 (미구현)

> **우선순위**: 낮음 — 핵심 기능 안정화 후 진행

### 4.1 3인 이상 대화
- **목표**: 최대 4인 대화 지원
- **파일**: 전체 파이프라인 수정
- **작업**:
  - 프론트엔드: 에이전트 동적 추가/삭제 버튼
  - dialog_parser: 에이전트 수 제한 완화 (2→4)
  - compositor:
    - Split: 3분할 (1/3씩), 4분할 (2x2 그리드)
    - PiP: 서브 화면 여러 개 (각 코너)
    - Switch: 동일 (발언자만 전체 화면)
  - 에이전트 badge 색상 C, D 추가

### 4.2 SoulX-FlashHead 1.3B 엔진 지원
- **목표**: 경량 엔진 옵션으로 빠른 생성
- **참고**: FlashHead Lite — RTX 4090에서 96 FPS, 3 concurrent 가능
- **파일**: `modules/flashhead_generator.py` (신규), `config.py` 수정
- **작업**:
  - FlashHead 모델 다운로드 + 통합
  - generate_turn_video()와 동일 인터페이스 구현
  - 프론트엔드: 엔진 선택 드롭다운 (FlashTalk 14B / FlashHead 1.3B)
  - FlashHead 동시 2캐릭터 로딩으로 idle 영상도 동시 생성 가능

### 4.3 LLM 기반 대화 자동 생성
- **목표**: 주제/상품명만 입력하면 대화 스크립트 자동 생성
- **작업**:
  - LLM API 연동 (Claude/GPT)
  - "상품 소개 대화 생성" 버튼 (상품명 + 특징 입력)
  - 생성된 대화를 에디터에 자동 채움 (사용자 편집 가능)

### 4.4 대화 영상 재편집
- **목표**: 특정 턴만 수정 후 해당 턴만 재생성 (전체 재생성 방지)
- **작업**:
  - 턴별 개별 영상 파일 유지 (현재는 temp에서 삭제)
  - 프론트엔드: 완성된 영상에서 턴 클릭 → 해당 턴 대사 수정 → 재생성
  - 수정된 턴만 TTS + 비디오 재생성 → 기존 합성 결과에 교체 적용

---

## Phase 5: 성능 최적화 (미구현)

> **우선순위**: Phase 2~3 완료 후 진행

### 5.1 TTS 선행 생성 (파이프라인 효율화)
- **현재**: TTS → 비디오 → TTS → 비디오 (순차)
- **목표**: 비디오 생성 중 다음 턴 TTS 미리 생성 (asyncio.gather 활용)
- **예상 효과**: 턴당 2-3초 절약 (10턴 기준 ~30초 단축)

### 5.2 동일 에이전트 연속 턴 최적화
- **현재**: 매 턴마다 prepare_params() 호출
- **목표**: 연속으로 같은 에이전트 턴이면 prepare_params 스킵
- **예상 효과**: prepare_params 오버헤드 제거 (~5-10초/스킵)

### 5.3 합성 파이프라인 최적화
- **현재**: 모든 턴 생성 완료 후 순차 합성
- **목표**: 생성 완료된 턴부터 합성 선행 시작 (streaming composition)
- **예상 효과**: 전체 시간에서 합성 시간 은닉

---

## 기술 스택

| 구성 요소 | 기술 |
|-----------|------|
| 립싱크 엔진 | SoulX-FlashTalk 14B |
| TTS | ElevenLabs `eleven_multilingual_v2` |
| 영상 합성 | ffmpeg (hstack, overlay, concat) |
| 백엔드 | FastAPI + asyncio + BackgroundTasks |
| 프론트엔드 | React 19 + Vite 7 |
| 진행 상태 | SSE (Server-Sent Events) |

## 예상 리소스

### 10턴 대화 (각 턴 ~5초)
- TTS: ~2-3초/턴 (ElevenLabs API) → 총 ~30초
- 립싱크: FlashTalk stream 모드, cpu_offload → 턴당 ~60-120초 → 총 ~10-20분
- 합성: ~10-30초 (ffmpeg)
- **총 예상**: ~12-22분 (10턴 대화)
- **VRAM**: ~40GB (cpu_offload 사용 시)

## 리스크 및 대응

| 리스크 | 대응 |
|--------|------|
| 비발언자 정지 프레임이 어색함 | Phase 2.1에서 idle 영상 생성 |
| 턴 간 전환이 부자연스러움 | Phase 2.2에서 crossfade + 오디오 블렌딩 |
| 긴 대화 시 생성 시간 과다 (10턴 ~20분) | Phase 4.2에서 FlashHead 1.3B 경량 엔진 도입 |
| ElevenLabs API 비용 (유료) | 에이전트별 음성 캐싱 / 대안 TTS 엔진 검토 |
| FlashTalk 14B VRAM 부족 | cpu_offload 필수, FlashHead로 대체 가능 |
| 3인+ 대화 시 레이아웃 복잡성 | Phase 4.1에서 단계적 확장 (3인 → 4인) |

## 구현 우선순위 요약

```
Phase 1  [완료]  FlashTalk 기반 MVP (파서 + 생성기 + 합성기 + API + UI)
Phase 2  [완료]  영상 품질 개선 (idle 영상, crossfade 전환, 에이전트별 프롬프트)
Phase 3  [계획]  프론트엔드 UX 개선 (TTS 파라미터, 음성 클론, 히스토리, 취소)
Phase 4  [계획]  확장 기능 (3인+, FlashHead, LLM 스크립트 생성, 재편집)
Phase 5  [계획]  성능 최적화 (TTS 선행, prepare_params 스킵, 스트리밍 합성)
```
