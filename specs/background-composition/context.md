# Background Composition - 기술 컨텍스트

## FlashTalk 이미지 처리 방식

FlashTalk은 conditioning 이미지(`cond_image`)를 **전체 프레임(인물+배경) 통째로** 처리한다.
- 입력 이미지를 `resize_and_centercrop()`으로 target 해상도(예: 768x448)에 맞춤
- VAE로 전체 프레임을 인코딩 → 생성 시 배경도 함께 재생성
- 인물과 배경을 분리하는 마스킹/세그먼테이션 없음
- **결론**: 배경을 바꾸려면 FlashTalk **입력 전에** 배경+인물 합성 이미지를 만들어야 함

## 필요한 전처리 파이프라인

```
사용자 입력:
  ├── 호스트 이미지 (인물 사진)
  ├── 배경 이미지
  └── 레이아웃 설정 (해상도, 레이아웃 등)

전처리 파이프라인:
  1. 호스트 이미지에서 인물 세그먼테이션 (배경 제거)
  2. 배경 이미지에서 사람 감지
     ├── 사람 없음 → 호스트를 적절한 크기/위치로 배경에 합성
     └── 사람 있음 → 기존 사람의 위치/크기에 맞춰 호스트를 교체 (face swap + 의상)
  3. 합성된 이미지를 FlashTalk의 cond_image로 사용

출력:
  └── 합성된 conditioning 이미지 → FlashTalk 파이프라인 진입
```

## 기술 선택지

### 인물 세그먼테이션 (배경 제거)
| 도구 | 특징 | 의존성 |
|------|------|--------|
| **rembg** | 간단한 API, U2-Net 기반, pip 설치 | `pip install rembg` |
| **SAM (Segment Anything)** | 고품질, 프롬프트 기반 | 무거움, GPU 필요 |
| **BackgroundMattingV2** | 가벼움, 실시간 가능 | 별도 모델 필요 |

→ **rembg 추천**: 간단하고 품질 충분, CPU로도 동작

### 사람 감지 (배경 이미지 내)
| 도구 | 특징 |
|------|------|
| **MediaPipe Pose** | 가볍고 빠름, 전신 키포인트 제공 |
| **YOLOv8** | 바운딩 박스 + 세그먼테이션 |
| **OpenPose** | 정밀한 포즈, 무거움 |

→ **MediaPipe 또는 YOLOv8 추천**: 사람 위치/크기 파악에 충분

### 얼굴+의상 교체 (배경에 사람이 있는 경우)
| 도구 | 특징 |
|------|------|
| **InsightFace + inswapper** | 얼굴 교체 (face swap), 빠름 |
| **IP-Adapter + ControlNet** | 의상+포즈 유지 인페인팅, 고품질 |
| **Stable Diffusion Inpainting** | 의상 교체 가능, GPU 필요 |

→ 얼굴만 교체: **InsightFace**, 의상까지 교체: **IP-Adapter 기반 인페인팅**

## Single Host vs Multi-Agent 모드 차이

### 공통
- Gemini 배경 생성: `compose_agents_together()` 함수 사용
- 참조 이미지 업로드: `/api/upload/reference-image` 공유
- 프리뷰 생성: `/api/preview/composite-together` 공유

### Single Host 고유
- `generate_video_task()` 내 Stage 0에서 Gemini 합성 수행
- 합성 결과를 `host_image` 변수에 직접 교체 → FlashTalk `cond_image`로 사용
- 호스트 1명이므로 `compose_agents_together(host_image_paths=[단일 경로])` 호출
- 합성 후 `release_models()`로 rembg 메모리 해제 → FlashTalk 로딩에 GPU 메모리 확보

### Multi-Agent 고유
- `generate_conversation_task()` 내 Stage 0에서 Gemini 합성 수행
- 다중 레이아웃 지원 (split, switch, pip)
- 에이전트별 crop된 이미지 반환

## 이미지 리사이즈 전략

Gemini API는 요청한 비율과 다른 비율의 이미지를 반환할 수 있다. 이를 처리하는 두 가지 방식:

| 방식 | 코드 | 결과 |
|------|------|------|
| `Image.resize(target_size)` (기존) | 강제 리사이즈 | 인물이 세로로 압축/늘어남 |
| `_resize_and_crop(img, target_size)` (개선) | 비율 유지 리사이즈 + center crop | 비율 유지, 가장자리 약간 잘림 |

→ **`_resize_and_crop()` 사용**: 인물 비율이 보존되므로 자연스러운 결과. 가장자리 잘림은 배경 부분이므로 품질에 영향 없음.

## Gemini 프롬프트 — 조명/그림자/투시 규칙

Gemini에 전달하는 프롬프트에 다음 규칙을 포함:

- **조명**: 씬의 주 광원 방향에 맞춰 인물에 일관된 조명 적용, 색온도 매칭, 림라이트/역광
- **그림자**: 바닥에 현실적 그림자 캐스팅 (접촉 그림자 + 투사 그림자), 광원 거리에 따른 경도
- **투시**: 바닥면 소실점 일치, 카메라 앵글 일관성, 주변 오브젝트 대비 인물 스케일
- **비율 보존**: 인물의 height-to-width ratio를 절대 변형하지 않도록 명시

## 제약사항

- FlashTalk은 합성 이미지의 품질에 민감 — 부자연스러운 합성은 생성 영상 품질 저하
- 배경 속 사람의 포즈와 호스트의 포즈가 매우 다르면 교체 결과가 부자연스러울 수 있음
- GPU 메모리 고려: FlashTalk (14B) + 추가 모델 (SAM, IP-Adapter 등) 동시 로딩 어려움
  → 전처리는 가벼운 모델(rembg, MediaPipe)로 하고, FlashTalk 로딩 전에 완료
