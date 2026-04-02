# Plan: 2인 쇼호스트 대화 영상 품질 개선

## Phase 1: FlashTalk + 알파 합성 (권장, 우선 구현)

### 핵심 원리
```
기존: [FlashTalk A] | [FlashTalk B] → hstack → 이음새 보임
개선: [배경 1장] + [인물 A 추출] + [인물 B 추출] → alpha composite → 이음새 없음
```

### Step 1: 배경 전용 이미지 생성
- **파일**: `modules/image_compositor.py`
- **변경**: `compose_agents_together()` 에 `alpha_composite` 모드 추가
- **동작**:
  - Gemini에 **배경만** 생성 요청 (사람 없이, 장면/세트 배경)
  - 프롬프트: "TV studio background for two hosts, no people, wide landscape shot"
  - 해상도: 최종 출력 해상도 (1280x720 또는 720x1280)
  - 결과: `bg_only.png` 저장

### Step 2: 에이전트별 FlashTalk 영상 생성 (기존 유지)
- **파일**: `modules/conversation_generator.py`
- **변경 없음**: 기존 FlashTalk 개별 생성 파이프라인 그대로 사용
- **동작**:
  - 에이전트 A: face_image + 오디오 → FlashTalk → `agent_a.mp4`
  - 에이전트 B: face_image + 오디오 → FlashTalk → `agent_b.mp4`
- **입력 이미지**: 인물 전체 (배경 포함) — FlashTalk이 생성한 그대로

### Step 3: 프레임별 인물 분리 (핵심 신규)
- **파일**: `modules/video_compositor.py` (신규)
- **라이브러리**: `rembg` (이미 설치됨, image_compositor.py에서 사용 중)
- **동작**:
  - 각 에이전트 영상의 매 프레임에서 인물만 추출 (alpha mask)
  - rembg의 U2-Net 모델 사용 (GPU 가속 가능)
  - 결과: 프레임별 RGBA 이미지 (인물 = 불투명, 배경 = 투명)
- **최적화**:
  - 매 프레임 처리는 느릴 수 있음 → batch 처리 또는 N프레임마다 처리 + interpolation
  - 또는 `robust-video-matting` 같은 비디오 전용 matting 모델 검토

### Step 4: 알파 합성 (핵심 신규)
- **파일**: `modules/conversation_compositor.py` 확장
- **함수**: `composite_alpha_blend()`
- **동작**:
  ```
  for each frame:
    bg = bg_image.copy()
    person_a = extract_person(agent_a_frame)  # RGBA
    person_b = extract_person(agent_b_frame)  # RGBA

    # 위치 배치 (왼쪽 25%, 오른쪽 75%)
    bg.paste(person_a, position_a, person_a_alpha)
    bg.paste(person_b, position_b, person_b_alpha)

    output_frame = bg
  ```
- **장점**: 배경이 하나이므로 이음새 **원천적으로 불가능**

### Step 5: 오디오 합성 + 최종 출력
- **기존 로직 유지**: ffmpeg로 오디오 합성
- **추가**: 프레임 시퀀스 → mp4 인코딩

### Step 6: app.py 통합
- **변경**: `generate_conversation_task()` 에 `composite_mode` 파라미터 추가
  - `"alpha"`: Phase 1 알파 합성 (기본값)
  - `"multitalk"`: 기존 MultiTalk 파이프라인
  - `"hstack"`: 기존 FlashTalk hstack + blur strip (fallback)
- **config.py**: `COMPOSITE_MODE = "alpha"` 기본값 설정

---

## Phase 1.5: Alpha Matting 반투명 문제 수정 (긴급)

> **문제**: 배경은 정상, 사람이 반투명하게 거의 보이지 않음
> **원인**: rembg u2net 모델이 AI 생성 프레임에서 약한 alpha(150~200) 출력 + 후처리 없음

### Step 6.1: Alpha 후처리 파이프라인 추가
- **파일**: `modules/video_matting.py`
- **함수**: `extract_person_frames()` 수정
- **동작**:
  ```python
  # rembg 출력 후 alpha 채널 보정
  alpha = rgba.split()[-1]
  # 1) Threshold: 약한 alpha → 불투명, 노이즈 → 투명
  alpha = alpha.point(lambda x: 0 if x < 25 else min(255, int(x * 1.5)))
  # 2) 최종 마스크에서 255 근처를 완전 불투명으로
  alpha = alpha.point(lambda x: 255 if x > 200 else x)
  rgba.putalpha(alpha)
  ```
- **효과**: 반투명 → 완전 불투명 인물, 깔끔한 배경 제거

### Step 6.2: rembg 모델을 u2net_human_seg로 변경
- **파일**: `modules/video_matting.py`
- **변경**: `new_session("u2net")` → `new_session("u2net_human_seg")`
- **이유**: u2net은 범용 객체 분리, u2net_human_seg는 인체 전용으로 더 정확
- **대안**: `isnet-general-use` 또는 `birefnet-general` (더 최신, 설치 필요 여부 확인)

### Step 6.3: FlashTalk 입력 배경 단순화 (선택)
- **파일**: `modules/image_compositor.py` 또는 `app.py`의 alpha mode Stage 0
- **아이디어**: alpha 모드에서 FlashTalk에 입력할 이미지의 배경을 **단색(예: #808080 회색)**으로 단순화
  - 복잡한 Gemini 배경 대신 단색 배경 + 인물 합성 → FlashTalk 생성
  - rembg가 단색 배경에서는 훨씬 정확하게 인물 분리 가능
- **주의**: 단색 배경이 FlashTalk 생성 품질에 영향을 줄 수 있음 → 테스트 필요
- **대안**: Gemini로 **그라데이션** 배경 생성 (사람 없이, 부드러운 톤) → 중간 타협

### Step 6.4: 디버그 출력 (개발용)
- **파일**: `modules/video_matting.py`
- **동작**: 첫 프레임의 matting 결과를 `temp/debug_matting_frame0.png`로 저장
- **목적**: 알파 마스크 품질을 시각적으로 확인

---

## Phase 2: 품질 고도화

### Step 7: rembg 대신 비디오 전용 matting 적용
- **후보**: `RobustVideoMatting` (MIT License, 실시간 가능)
- **장점**: 프레임 간 시간적 일관성 → 인물 경계 떨림 없음
- **rembg 문제점**: 프레임별 독립 처리 → 경계가 프레임마다 미세하게 달라 떨림 발생 가능

### Step 8: 배경 동적 효과 (선택)
- 정적 배경 이미지 대신 **미세한 움직임** 추가 (카메라 미세 흔들림, 조명 변화)
- 간단한 affine transform + 노이즈로 구현 가능

### Step 9: 그림자/반사/조명 보정
- 인물을 배경에 합성할 때 자연스러운 그림자 추가
- 배경 조명에 맞는 인물 색온도 보정

---

## Phase 3: MultiTalk 유지보수 (백업)

### Step 10: TeaCache 적용
- MultiTalk의 40 steps 중 유사한 step을 캐싱
- 예상 2-3배 속도 향상 (120 passes → ~50 passes)
- 참고: 공식 MultiTalk repo에 `--use_teacache` 옵션 존재

### Step 11: INT8 양자화
- `dit_model_int8.safetensors` (17.8GB) 활용
- VRAM 절약 + 약간의 속도 향상
- quanto 라이브러리 기반 requantize

### Step 12: 720P 모델 대응 준비
- MeiGen-AI에서 720P MultiTalk 모델 출시 시 즉시 교체 가능하도록
- `MULTITALK_CKPT_DIR` 만 변경하면 되는 구조 유지

---

## 파일 변경 요약

| 파일 | 변경 내용 |
|------|-----------|
| `modules/video_compositor.py` | **신규**: 프레임별 인물 분리 + 알파 합성 |
| `modules/image_compositor.py` | 배경 전용 생성 모드 추가 |
| `modules/conversation_compositor.py` | `composite_alpha_blend()` 추가 |
| `modules/conversation_generator.py` | 변경 없음 (FlashTalk 그대로) |
| `app.py` | `composite_mode` 파라미터 + 라우팅 |
| `config.py` | `COMPOSITE_MODE = "alpha"` 추가 |
| `frontend/` | 합성 모드 선택 UI (선택) |

## 예상 결과

| 항목 | 현재 (hstack) | 현재 (MultiTalk) | 개선 후 (Alpha) |
|------|---------------|-------------------|-----------------|
| 이음새 | 있음 (blur 처리) | 없음 | **없음** |
| 인당 품질 | FlashTalk 수준 | 480P 수준 | **FlashTalk 수준** |
| 생성 속도 | 빠름 (4 steps) | 매우 느림 (120 passes) | **빠름 (4 steps + matting)** |
| 배경 일관성 | 각자 다른 배경 | 하나의 배경 | **하나의 배경** |
| 구현 복잡도 | 낮음 | 높음 | **중간** |

## 우선순위
1. **즉시**: Step 1-6 구현 (FlashTalk + 알파 합성) — 가장 큰 품질 향상
2. **다음**: Step 7 (비디오 matting) — 떨림 제거
3. **선택**: Step 8-9 (시각 효과) — 추가 자연스러움
4. **백업**: Step 10-12 (MultiTalk 최적화) — 향후 720P 모델 대비
