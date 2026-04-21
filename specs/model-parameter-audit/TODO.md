# 모델 파라미터 감사 및 프로바이더 업그레이드 TODO

> 상태: 📋 **검토/기획 단계** — 각 항목 영향도/리스크 평가 중.
> 작성일: 2026-04-20
> 범위: 외부 API(Gemini, ElevenLabs) 호출부의 파라미터 누락/오설정 및 동일 프로바이더 내 상위 모델 적용 검토

---

## 대상 모델 요약

| 기능 | 모델 | 위치 | 교체 가능? |
|---|---|---|---|
| 배경 이미지 생성 | `gemini-3-pro-image-preview` | `modules/image_compositor.py:242,487` | ✅ Flash 계열로 |
| TTS | `eleven_multilingual_v2` | `config.py:50`, `modules/elevenlabs_tts.py` | ✅ v3로 (별도 TODO 참조) |
| 음성 임베딩 | `chinese-wav2vec2-base` | `config.py:22` | ❌ FlashTalk 학습과 결합 |
| 비디오 생성 | Wan MultiTalk 14B / FlashTalk 14B | `config.py:24-43` | ❌ 로컬 모델 |

관련 TODO: [`specs/elevenlabs-voice-quality/TODO.md`](../elevenlabs-voice-quality/TODO.md)

---

## 🎨 Gemini 이미지 생성

### 배경 및 관찰

현재 `gemini-3-pro-image-preview` (일명 **Nano Banana Pro**) 사용 중.
공식 docs상 Pro는 "professional asset production, advanced reasoning (Thinking always on)" 포지션 — **복잡한 타이포/여러 참조 이미지 합성** 용도. 이 프로젝트의 "배경 생성 후 인물 알파 합성" 파이프라인에는 **스펙 과잉**.

### 모델 계열 비교 (2026-04 기준)

| 모델 ID | 특성 | 비고 |
|---|---|---|
| `gemini-3-pro-image-preview` (현재) | 최고 품질, Thinking 항상 ON, 느림, 고비용 | 타이포/복잡 구성에 유리 |
| `gemini-3.1-flash-image-preview` (Nano Banana 2) | **Pro의 고효율 버전**, `thinking_level` 조절 가능 (minimal/high) | **이 프로젝트 적합** |
| `gemini-2.5-flash-image` (Nano Banana 초기) | 가장 저렴/빠름, 구세대 | 레거시 호환용 |

### 누락/부정확 파라미터 감사

| 파라미터 | 현재 | 권장 | 영향도 |
|---|---|---|---|
| `image_config.aspect_ratio` | ❌ 미설정 | `"9:16"` (세로 영상) 또는 호스트 이미지와 매칭 | 🔴 **높음** — 배경 크롭/왜곡 원인 |
| `image_config.image_size` | ❌ 미설정 | `"1K"` 또는 `"2K"` | 🟡 중 — 해상도 컨트롤 명시 |
| `thinking_config.thinking_level` | ❌ | Flash 전환 시 `"minimal"` | 🟡 중 — 레이턴시 단축 |
| `safety_settings` | ❌ 미설정 | 프로젝트 요구에 맞춰 명시 | 🟡 중 — 한국어 프롬프트 false-positive 대응 |
| `system_instruction` | ❌ 미설정 | 전경 인물 보호 가드 문구 | 🔴 **높음** — 현재 user prompt에 가드를 섞어넣는 구조 |
| `response_modalities` | `["Text", "Image"]` | `["TEXT", "IMAGE"]` (대문자 권장) | 🟢 낮음 — SDK가 정규화 |

### TODO

- [ ] **T-GM1. 모델 다운그레이드 검토 (Pro → 3.1 Flash)**
  - 변경: `model="gemini-3.1-flash-image-preview"`
  - 속도/비용 개선, 배경 품질 체감 비교 필요
  - A/B 샘플 10개씩 생성 후 사내 평가

- [ ] **T-GM2. `aspect_ratio` 명시 추가** (🔴 우선)
  - 호스트 이미지 종횡비에서 도출하거나 세로 영상 기본 `"9:16"`
  - `_gemini_generate_scene()` 시그니처에 `aspect_ratio` 파라미터 추가

- [ ] **T-GM3. `system_instruction`으로 전경 보호 가드 추가** (🔴 우선)
  - 예시: `"Preserve the foreground subject's identity, position, and proportions exactly. Only generate or modify the background."`
  - 현재는 프롬프트에 섞여 있어 사용자 scene_prompt와 충돌 가능

- [ ] **T-GM4. `thinking_level="minimal"`** (T-GM1 진행 시)
  - 3.1 Flash 전환 시 기본 minimal로 세팅 — 품질 저하 미미, 레이턴시 대폭 단축

- [ ] **T-GM5. `safety_settings` 명시**
  - 한국어 설명 문장 false-positive 리스크 방지
  - 최소: `HARM_CATEGORY_*`를 `BLOCK_NONE` 또는 `BLOCK_ONLY_HIGH`로

- [ ] **T-GM6. `image_size="1K"` 또는 `"2K"` 명시**
  - Wan 입력이 768x448이므로 1K면 충분 — 업스케일 낭비 방지

### 참조 구현 (개선안)

```python
from google.genai import types

response = client.models.generate_content(
    model="gemini-3.1-flash-image-preview",
    contents=contents,
    config=types.GenerateContentConfig(
        response_modalities=["TEXT", "IMAGE"],
        image_config=types.ImageConfig(
            aspect_ratio="9:16",
            image_size="1K",
        ),
        thinking_config=types.ThinkingConfig(thinking_level="minimal"),
        system_instruction=(
            "Preserve the foreground subject's identity, position, and proportions exactly. "
            "Only generate or modify the background."
        ),
        # safety_settings=[...]
    ),
)
```

---

## 🗣️ ElevenLabs TTS

### 배경

v2 → v3 모델 전환은 별도 TODO 문서에서 다룸([elevenlabs-voice-quality](../elevenlabs-voice-quality/TODO.md#t1-model_id를-eleven_v3로-전환-테스트)).
여기서는 **voice_settings 및 요청 페이로드 파라미터 감사**만.

### 현재 페이로드 (`modules/elevenlabs_tts.py:generate_speech`)

```python
{
    "text": text,
    "model_id": "eleven_multilingual_v2",
    "voice_settings": {
        "stability": 0.5,
        "similarity_boost": 0.75,
        "style": 0.0,
    }
}
```

### 누락/부정확 파라미터 감사

| 파라미터 | 현재 | 권장 | 영향도 |
|---|---|---|---|
| `voice_settings.use_speaker_boost` | ❌ **미설정** | `true` | 🔴 **높음** — 클론 음성 유사도↑ |
| `voice_settings.speed` | ❌ 미설정 | `1.0` (명시) | 🟡 중 — 말하기 속도 안정화 |
| `language_code` | ❌ 미설정 | `"ko"` | 🟡 중 — 다언어 모델의 한국어 특화 |
| `seed` | ❌ 미설정 | 고정값 (재현용) | 🟢 낮음 — 디버깅/회귀 |
| `voice_settings.stability` | `0.5` | v3에선 0.3~0.4 실험 가치 | 🟡 — v3 전환 후 재튜닝 |
| `voice_settings.similarity_boost` | `0.75` | 유지 OK | 🟢 |
| `voice_settings.style` | `0.0` | v3에선 0.3~0.5 실험 | 🟡 — v3 전환 후 |
| `output_format` | `"pcm_16000"` | ✅ Wav2Vec 입력 맞춤 | 🟢 정상 |
| `previous_text` / `next_text` | ❌ 미사용 | 긴 대화 흐름 컨텍스트 전달 | 🟡 — 멀티턴 자연스러움 |

### TODO

- [ ] **T-EL1. `use_speaker_boost: true` 추가** (🔴 즉시 — 1줄 변경)
  - 위치: `modules/elevenlabs_tts.py` voice_settings dict
  - 영향: 클론한 호스트 음성 유사도 체감 향상, 부작용 거의 없음

- [ ] **T-EL2. `language_code="ko"` 추가**
  - 한국어 발음/억양 최적화 경로 활성

- [ ] **T-EL3. `speed: 1.0` 명시**
  - 서버 디폴트 의존 제거, 예측 가능성↑

- [ ] **T-EL4. 멀티턴 `previous_text` / `next_text` 전달**
  - `conversation_generator.py`에서 이전/다음 turn 텍스트를 prev/next로 넘기면
    TTS가 대화 흐름 인식 → 자연스러움 개선
  - 구조 변경: turn 생성 루프에서 window 유지 필요

- [ ] **T-EL5. `seed` 고정 옵션 추가**
  - config.py에 `"seed": None` 추가, 디버깅 시 특정 값으로 고정

---

## 🎧 Wav2Vec2 (참고용 — 교체 불가)

| 항목 | 내용 |
|---|---|
| 현재 | `chinese-wav2vec2-base` (로컬) |
| 대안 | `kresnik/wav2vec2-large-xlsr-korean`, `facebook/mms-1b-all`, `whisper-v3` 등 |
| **교체 가능?** | ❌ **불가** — FlashTalk 14B가 이 모델의 특징 공간에 맞춰 학습됨. 교체 시 음성↔영상 동기 붕괴 |
| 조치 | 주석 보강 정도: "chinese-wav2vec2는 이름에 반해 한국어 피처 추출로도 동작, FlashTalk와 결합되어 변경 불가" |

### TODO

- [ ] **T-WV1. 주석/문서에 "교체 불가" 명시**
  - `config.py:22` 인라인 주석 또는 README/CLAUDE.md에 추가
  - 향후 기여자 혼동 방지

---

## 🎬 Wan MultiTalk 14B / FlashTalk (파라미터 정상)

감사 결과 **문제 없음**. 참고용 기록:

| 파라미터 | 값 | 평가 |
|---|---|---|
| `sample_steps` (FlashTalk) | 4 | ✅ Distilled 모델 전용 timesteps 매핑 |
| `sample_steps` (MultiTalk) | 40 | ✅ Non-distilled 적정값 |
| `audio_lufs` | -28 | ✅ 입모양 과장 완화 목적 (최근 커밋 의도적) |
| `cpu_offload` | True | ✅ VRAM 40GB 최적화 |
| CFG / guidance_scale | 미사용 (`noise_pred = -noise_pred_cond`) | ⚠️ 의도적 — distilled 모델의 부호 반전 샘플링 (`flash_talk_pipeline.py:311`). **건드리지 말 것** |

### TODO

- [x] (행동 불필요) 현재 파라미터 유지

---

## 📊 우선순위 요약

### 🔴 즉시 적용 가능 (변경 1~수줄)
1. **T-EL1** — `use_speaker_boost: true` (TTS 품질↑ 즉시 체감)
2. **T-GM2** — Gemini `aspect_ratio` 명시 (배경 크롭 문제 해결)
3. **T-GM3** — Gemini `system_instruction`로 전경 보호 (인물 변형 방지)

### 🟡 검토/실험 필요
4. **T-GM1** — Gemini Pro → 3.1 Flash 다운그레이드 (A/B 필요)
5. **T-EL2/3** — `language_code`, `speed` 명시
6. **T-EL4** — 멀티턴 `previous_text`/`next_text` (conversation 구조 개편)

### 🟢 저우선 / 보조
7. **T-GM4/5/6** — Flash 전환 후 thinking/safety/image_size
8. **T-EL5** — seed 고정 옵션
9. **T-WV1** — Wav2Vec2 불가 명시 주석

## 결정 대기

1. T-GM1 (Pro → Flash) 실제 품질 차이를 A/B로 먼저 볼지, 아니면 일단 파라미터만 보강(T-GM2, T-GM3)하고 모델은 유지할지
2. T-EL4 멀티턴 컨텍스트 — 대화 자연스러움 개선 체감 vs 구현 복잡도
3. 즉시 적용군(T-EL1, T-GM2, T-GM3) 지금 바로 착수할지, 다른 검토 마치고 묶어서 PR 낼지
