# ElevenLabs TTS 품질 개선 TODO

> 상태: 📋 **검토/기획 단계** — 구현 착수 전. 각 항목 ROI 평가 중.
> 작성일: 2026-04-20
> 관련 영역: TTS, 음성 클로닝, 자연스러움, 멀티에이전트 대화

## 배경

사용자가 본인 목소리로 TTS를 생성하는 기능의 **자연스러움 갭**이 현재 과제.
현재 기본값은 `eleven_multilingual_v2` + IVC(Instant Voice Cloning) 조합.

## 현재 구현 현황

| 영역 | 상태 | 위치 |
|---|---|---|
| IVC 클로닝 API | ✅ 구현 | `modules/elevenlabs_tts.py:111-146` (`clone_voice`) |
| 음성 목록 조회 | ✅ 구현 | `modules/elevenlabs_tts.py:31-46` (`list_voices`) |
| 음성 삭제 | ✅ 구현 | `modules/elevenlabs_tts.py:148-155` (`delete_voice`) |
| 참조 오디오 업로드 API | ✅ 구현 | `app.py:654-664` (`/api/upload/reference-audio`) |
| 클로닝 API 엔드포인트 | ✅ 구현 | `app.py:747-776` (`/api/elevenlabs/clone-voice`) |
| VideoGenerator UI 클로닝 | ✅ 구현 | `frontend/.../VideoGenerator.jsx:175-204`, `503-514` |
| ConversationGenerator UI 클로닝 | ❌ **미구현** | `ConversationGenerator.jsx:353-375` (preset 드롭다운만) |
| 오디오 품질 검증/전처리 | ❌ **미구현** | 업로드 후 바로 ElevenLabs 전송 |
| 모델 버전 | 🟡 v2 사용 중 | `config.py:50` (`eleven_multilingual_v2`) |

## TODO 항목

### 🟢 Priority 1: 무료/즉시 효과

- [ ] **T1. `model_id`를 `eleven_v3`로 전환 테스트**
  - 변경 지점: `config.py:50` 한 줄
  - 기대 효과: 한국어 자연스러움↑, 감정 태그(`[laughs]`, `[whispers]`) 지원
  - 주의: 요청당 문자 제한 10,000 → 5,000으로 **감소** (`conversation_generator.py` turn 분할 로직 검토 필요)
  - 가격: **동일 ($0.10/1K chars)** — 확인 완료 (elevenlabs.io/pricing/api)
  - 검증: A/B 샘플 생성해 기존 대비 체감 비교

- [ ] **T2. MP3 업로드 품질 검증 + 자동 정규화 파이프라인**
  - 위치: `app.py:654` (`/api/upload/reference-audio`) 또는 `clone_voice()` 직전
  - 필요 체크:
    - 길이 30초 ~ 3분 (`librosa.get_duration`)
    - 볼륨 LUFS 측정 + 정규화 (-23~-18 LUFS 목표, `pyloudnorm` — 이미 설치됨)
    - 피크 dBFS (클리핑 검출, ≥ -1 dBFS면 warning)
    - 앞뒤 무음 트리밍 (`librosa.effects.trim`)
    - 기본 SNR 추정 (노이즈 너무 많으면 reject)
  - 산출물: 정규화된 WAV를 ElevenLabs로 전송 → IVC 품질 체감 상승
  - 예상 코드량: 30~50줄

### 🟡 Priority 2: UX 갭 메우기

- [ ] **T3. ConversationGenerator에 클로닝 UI 이식**
  - 위치: `frontend/.../ConversationGenerator.jsx` (현재 353-375 preset 드롭다운)
  - 작업: `VideoGenerator.jsx:175-204`의 `handleCloneVoice` 패턴 복사
  - 백엔드는 이미 준비됨 — UI만 추가
  - 예상: 3~5시간

- [ ] **T4. 업로드 전 사용자 가이드 (프론트)**
  - 샘플 길이, 조용한 환경, 단일 톤 유지 등 체크리스트 표시
  - 업로드 후 파형 + LUFS 미터 시각화 (선택)
  - T2와 시너지

### 🔴 Priority 3: 유료 결정 필요

- [ ] **T5. PVC(Professional Voice Cloning) 검토**
  - 요구 사항: ElevenLabs **Creator 플랜 이상** ($22/월)
  - 훈련 시간: 한국어 약 6시간 (비자동, 대시보드 수동)
  - 효과: IVC 대비 "원본과 구별 불가" 수준
  - 자동화: 완전 자동화 어려움 (대시보드 의존) → 관리자가 특정 호스트만 PVC로 학습 후 voice_id 고정 배포하는 방식이 현실적
  - 의사결정: "프리미엄 호스트 캐릭터" 몇 명에 PVC 적용할지 기획 필요

### 🔬 탐색/리서치

- [ ] **T6. v3 감정 태그 활용 전략**
  - `[laughs]`, `[whispers]`, `[excited]`, `[sighs]` 등 지원
  - `conversation_generator.py`의 대화 스크립트 생성 로직에 감정 태그 주입 방식 설계
  - 자동 감정 추정(LLM) 도입 여부 — 현재 외부 LLM 미사용 상태와의 트레이드오프

- [ ] **T7. Text to Dialogue API 검토**
  - v3의 별도 API로 멀티 스피커 대화 네이티브 생성
  - 현재 `conversation_generator.py`가 turn별 개별 TTS 호출 → 이 API로 대체 가능성
  - turn 간 자연스러운 반응/침묵/겹침 표현 잠재 개선

## 참고 링크

- Models overview: https://elevenlabs.io/docs/models
- API pricing: https://elevenlabs.io/pricing/api
- IVC guide: https://elevenlabs.io/docs/product-guides/voices/voice-cloning/instant-voice-cloning
- PVC guide: https://elevenlabs.io/docs/product-guides/voices/voice-cloning

## 결정 대기

1. T1(v3 전환) 먼저 시도할지 vs T2(품질 파이프라인) 먼저 할지
2. T5(PVC 구독) 도입 여부 — 비용 vs 품질 체감 트레이드오프
3. T3(UI 이식) 우선순위 — 대화형 모드 사용 빈도에 달림
