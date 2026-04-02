# Context: MultiTalk 품질 개선

## 현재 상황

### 시스템 구성
- **FlashTalk**: 14B distilled model (4 steps, no CFG) - 단일 인물 고품질 실시간 생성
- **MultiTalk**: Wan2.1-I2V-14B-480P + multitalk.safetensors (40 steps, dual-axis CFG) - 다중 인물 생성
- **GPU**: 4x A100 80GB
- **파이프라인**: FlashTalkPipeline 클래스를 공유, checkpoint_dir만 다름

### 해결하려는 근본 문제
두 쇼호스트가 나란히 있는 대화 영상에서 **자연스러운 한 화면**을 만들고 싶음.

### 시도한 접근법과 결과

| 접근법 | 결과 | 근본적 한계 |
|--------|------|-------------|
| FlashTalk 개별생성 + hstack | 가운데 이음새(seam) 보임 | 각 에이전트가 독립 생성되어 배경 불일치 |
| FlashTalk + Gaussian blur strip | seam 약간 완화 | 배경 자체가 다르면 blur로 해결 불가 |
| FlashTalk + blend overlay | 사람이 사라짐 | 사람이 중앙에 위치해 blend에 의해 소실 |
| MultiTalk (FlashTalk weights) | 입 안 움직임, 사람 겹침 | FlashTalk weights에 audio cross-attn 없음 |
| MultiTalk (proper weights, no CFG) | 움직이지만 매우 흐릿 | CFG 없이는 non-distilled 모델 출력 불가 |
| MultiTalk (dual-axis CFG + Euler) | 이전보다 나음, 여전히 저품질 | 해상도 832x448 (세로) → 인당 224px |
| MultiTalk (landscape 1024x384) | 해상도 개선 | **아직 FlashTalk 대비 품질 부족** |

### 현재 MultiTalk의 근본적 품질 문제 원인 분석

1. **해상도 한계**: 480P 모델의 최대 해상도가 낮음 (1024x384 landscape)
2. **속도 문제**: 40 steps × 3 CFG passes = 120 model forward passes/chunk (FlashTalk: 4 passes)
3. **모델 본질적 차이**: MultiTalk은 FlashTalk의 self-correcting bidirectional distillation을 거치지 않은 원본 모델
4. **FlashTalk의 설계 목적**: 애초에 single-person에 최적화된 distilled model → multi-person은 지원 안 함
5. **torch.compile 비호환**: MultiTalk 3-pass inference에서 torch.compile 그래프 재사용 불가

### FlashTalk vs MultiTalk 핵심 비교

| 항목 | FlashTalk (현재 단일 인물) | MultiTalk (현재 다중 인물) |
|------|---------------------------|---------------------------|
| 모델 크기 | ~38GB (distilled) | ~70GB (base + multitalk) |
| 생성 steps | 4 | 40 |
| CFG | 불필요 (distilled) | 필수 (text=5.0, audio=4.0) |
| Forward pass/step | 1 | 3 |
| 총 forward pass/chunk | 4 | 120 |
| 해상도 | 768x448 (per person) | 1024x384 (2 people in 1 frame) |
| 인당 유효 해상도 | 768x448 | ~512x384 |
| 품질 | 높음 (distilled + self-correction) | 중간 (원본 base model) |
| 속도 | ~0.87초 first frame | ~30배 느림 |

### SoulX 생태계 기술 참고 (연구 보고서 기반)

- **Self-correcting Bidirectional Distillation**: FlashTalk만의 기술, chunk 내 양방향 attention 유지
- **Oracle-Guided Distillation**: 장기 일관성 확보, 학생 모델이 GT motion frame 참조 학습
- **3D VAE Parallelism**: VAE 디코더 병렬화 5배 가속
- **xDiT Hybrid Sequence Parallelism**: 다중 GPU에서 attention 워크로드 분산
- **Audio Context Cache**: 무한 길이 스트리밍을 위한 오디오 캐시 운영

---

## Phase 1 구현 결과: Alpha 합성 반투명 문제 (2026-04-02)

### 현상
- **배경**: 정상 렌더링 (Gemini 배경 잘 나옴)
- **사람**: 반투명하게 거의 안 보임 (유령처럼 비침)

### 근본 원인 분석

| 원인 | 심각도 | 설명 |
|------|--------|------|
| rembg u2net 모델의 약한 alpha 출력 | **높음** | AI 생성 프레임에서 alpha 값이 150~200 (0~255 기준), 255에 훨씬 못 미침 |
| alpha 후처리 없음 | **치명적** | 약한 alpha 값을 보정하는 thresholding/boosting 코드 없음 |
| PIL paste가 alpha를 투명도로 해석 | **치명적** | alpha=180이면 ~70% 불투명 → 배경이 비침 |
| 복잡한 Gemini 배경 위의 인물 분리 | **중간** | 복잡한 배경은 rembg 정확도를 낮춤 |

### 기술 상세

#### rembg alpha 문제
```python
# video_matting.py - 현재 코드
rgba = remove(img, session=session)  # alpha가 150~200, 255가 아님

# canvas에 합성할 때
canvas.paste(person_resized, (paste_x, paste_y), person_resized)
# PIL은 alpha를 투명도로 사용 → alpha=180이면 30% 투명 → 사람이 비침
```

#### FlashTalk 생성 이미지의 특성
- FlashTalk은 Gemini 합성 배경 위에 인물을 생성 → 배경이 복잡
- rembg의 u2net은 AI 생성 이미지에서 edge 품질이 떨어짐
- 특히 머리카락, 의복 경계에서 alpha가 급격히 약해짐

### 해결 방향 및 적용 결과

1. ✅ **Alpha 후처리**: threshold + boost로 약한 alpha를 255로 강화 → 반투명 해결
2. ✅ **rembg 모델 업그레이드**: `u2net` → `u2net_human_seg` (인체 전용) → 정확도 향상
3. ✅ **FlashTalk 입력 배경 단순화**: 단색 회색(180,180,180) 배경 → rembg 추출 용이
4. **비디오 전용 matting**: RobustVideoMatting → Phase 2에서 적용 예정

---

## Phase 1.7 결과: 윤곽선 + 입모양 과장 문제 (2026-04-02)

### 현상
- **배경과 인물 경계**: 하드 엣지로 부자연스러움 (오려붙인 듯한 느낌)
- **입모양**: 과장되게 말하는 것처럼 보임

### 원인 분석

| 원인 | 심각도 | 설명 |
|------|--------|------|
| `_boost_alpha()`에서 alpha > 180 → 255 하드 전환 | **높음** | 경계에서 급격한 alpha 변화 → 딱딱한 윤곽선 |
| 입력 오디오 정규화 LUFS -23 | **중간** | 표준 방송 레벨이지만 FlashTalk distilled 모델에서 과도한 입움직임 유발 |

### 적용한 해결책

1. ✅ **Edge Feathering**: alpha boost 후 경계에 Gaussian blur(radius=3) 적용
   - 내부(alpha >= 250): 하드 유지, 경계(alpha < 250): soft blur
2. ✅ **Audio LUFS 감쇠**: -23 → -28 LUFS (5dB 감쇠, ~56% 볼륨)
   - `config.py`의 `audio_lufs` 파라미터로 조절 가능
