# Pipeline V2 — 호스트 생성 + 제품/배경 합성 단계 도입

> 상태: 📋 **기획 확정 전 최종 초안** — 아래 결정사항 기반으로 구현 가능.
> 작성일: 2026-04-21
> 관련 문서: [elevenlabs-voice-quality](../elevenlabs-voice-quality/TODO.md), [model-parameter-audit](../model-parameter-audit/TODO.md)

## 개요

현재 파이프라인은 **프리셋 호스트 이미지**(`woman.png` 등)를 기반으로 바로 영상 생성으로 들어감. V2는 그 앞단에 **2개의 명시적 스테이지**를 도입:

1. **호스트 메이커** — 사용자가 원하는 AI 쇼호스트를 생성·선택
2. **씬 합성기** — 호스트 + 제품 + 배경을 한 장으로 합쳐 영상 생성의 시각적 기반을 만듦

FlashTalk + TTS 영상 생성 단계는 **기존 그대로 유지**. 새로운 단계는 그 앞에 얹힘.

## 파이프라인 개괄

```
[Stage 1: 호스트 메이커]
  ├─ 1-1 text-to-image (프롬프트만)
  ├─ 1-2 image-to-image (얼굴 + 옷 구조적 결합)
  ├─ 1-3 image-to-image (참조 사진 1장 → 스타일 차용)
  └─ 1-4 저장된 호스트 재사용
        ↓
  N=4 후보 생성 → 1장 선택
        ↓
  state.host.imageUrl ─────┐
                            │
[Stage 2: 씬 합성기]        │
  입력:                     │
  ├─ 호스트 (1단계 자동 전달)◄┘
  ├─ 제품 사진 (업로드, 다수 가능, 자동 rembg)
  ├─ 배경 (프리셋/업로드/자유 프롬프트)
  └─ 구도 (자유 텍스트 + 예시 칩)
        ↓
  N=4 후보 생성 → 1장 선택
        ↓
  state.composition.imageUrl
        ↓
[기존 단계: FlashTalk + TTS + 영상 렌더]
```

## 상태 머신 (valid 체인)

| 변수 | 조건 | 활성화되는 것 |
|---|---|---|
| `valid[1]` | `!!state.host.imageUrl` | Stage 2 접근 가능, "다음 단계" 버튼 활성 |
| `valid[2]` | `valid[1] && !!state.composition.imageUrl` | Stage 3(기존 영상 생성) 접근 가능 |

모든 UI(TopBar 진행 배지, 하단 "다음" 버튼, 미리보기 패널 모드)는 이 값을 공유.

---

## Stage 1 — 호스트 메이커

### 입력 방식 4가지 (탭 선택)

| # | 탭 이름 | 입력 필드 | Gemini 동작 |
|---|---|---|---|
| 1-1 | **설명으로 만들기** | 텍스트 프롬프트 | text-to-image |
| 1-2 | **사진으로 만들기** | 얼굴 사진 + 옷 사진 + 보조 프롬프트(선택) | image-to-image (구조적 결합) |
| 1-3 | **내 사진 올리기** | 참조 사진 1장 + 보조 프롬프트(선택) | image-to-image (스타일 참조) |
| 1-4 | **저장된 호스트** | 드롭다운 선택 | 재사용, 생성 없음 |

> 주의: 1-3 "내 사진 올리기"는 **업로드 사진을 그대로 쓰지 않음**. Gemini image-to-image로 AI 재해석하여 새 호스트 이미지를 생성. "이 느낌으로 만들어줘" 컨셉.

### 사용자 흐름

1. 탭 선택 → 입력 채우기
2. `[쇼호스트 만들기]` 버튼 클릭 → **N=4 후보** 생성 (2×2 그리드)
3. 후보 중 1장 클릭 → 선택 (테두리 강조)
4. (선택) `[내 호스트로 저장]` 버튼 → 저장소에 추가
5. `[다음 단계]` 버튼 활성화 → Stage 2로

### 후보 생성 파라미터

- **N = 4 고정** (2×2 2K 세로 그리드에 잘 맞음)
- 병렬 호출: `asyncio.gather([client.models.generate_content(...)] * 4)`
- 레이턴시: 병렬이라 단일 호출과 유사 (~15-25초)
- 비용: 단일 호출의 4배
- `[1장만 더 뽑기]`: +1회 호출 (기존 3장은 유지)
- `[다시 뽑기]`: 기존 4장 버리고 새 4장

### Gemini 파라미터 (V2에서 적용 권장)

```python
response = client.models.generate_content(
    model="gemini-3.1-flash-image-preview",      # Pro → Flash (속도/비용 ↓)
    contents=[prompt, *reference_images],
    config=types.GenerateContentConfig(
        response_modalities=["TEXT", "IMAGE"],
        image_config=types.ImageConfig(
            aspect_ratio="9:16",
            image_size="1K",
        ),
        thinking_config=types.ThinkingConfig(thinking_level="minimal"),
        system_instruction=(
            "Generate a single person (AI shopping host) in a neutral pose. "
            "No products, no furniture, no complex background. "
            "Focus on face and outfit clarity."
        ),
    ),
)
```

### 완료 조건

```python
valid[1] = bool(state.host.imageUrl)
```

### 출력

```typescript
state.host = {
    imageUrl: string,           // 서버에 저장된 안정 URL
    sourceMethod: "text" | "face-outfit" | "style-ref" | "saved",
    metadata: {
        prompt?: string,
        faceRefUrl?: string,
        outfitRefUrl?: string,
        styleRefUrl?: string,
        savedHostId?: string,
    }
}
```

---

## Stage 2 — 씬 합성기

### 선행 조건

`valid[1] === true`. 미충족 시 이 단계 UI는 비활성화.

### 입력

| 항목 | 입력 방식 | 비고 |
|---|---|---|
| **호스트** | Stage 1에서 자동 연결 | 사용자 조작 불필요 |
| **제품** | 업로드 (다수 가능) | URL 입력은 V2. 업로드 시 자동 rembg (체크박스로 OFF 가능) |
| **배경** | 3방식 중 택1: **프리셋** / **업로드** / **자유 프롬프트** | 프리셋은 **프롬프트 템플릿** (예: "깔끔한 스튜디오"), 클릭 시 text-to-image |
| **구도** | 자유 텍스트 + 예시 칩 3-4개 | "호스트 왼쪽·제품 오른쪽" 같은 자연어 |

### 사용자 흐름

1. 제품 사진 업로드 (1장 이상)
2. 배경 선택 (프리셋 / 업로드 / 프롬프트)
3. (선택) 구도 입력 또는 예시 칩 클릭
4. `[합성 이미지 만들기]` 클릭 → **N=4 후보** 생성
5. 후보 1장 선택 → `[다음 단계]`

### 제품 전처리 (rembg)

- **기본값 ON**: 업로드 직후 자동 배경 제거, 썸네일에 처리 결과 즉시 반영
- **OFF 케이스**: 제품이 배경과 의미적으로 결합된 경우(음식 플레이팅, 가구 인테리어 샷)
- UI: 썸네일 아래 `[✓] 배경 자동 제거` 체크박스
- 가이드 문구: "정면 · 배경 단색 · 워터마크 없음 권장"

### Gemini 파라미터

```python
contents = [
    composition_prompt,           # 자유 텍스트 + 내부 구조화
    host_image,                   # Stage 1 결과
    *product_images_rembg,        # rembg 처리된 제품들
    *background_inputs,           # 이미지 or 프롬프트
]

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
            "Compose a single still image containing: "
            "(1) the provided host person (preserve identity/outfit), "
            "(2) the product(s), (3) the described background. "
            "Follow composition instructions strictly. "
            "Do not add text, watermarks, or additional people."
        ),
    ),
)
```

Gemini는 최대 14장의 참조 이미지를 받을 수 있으므로 (host 1 + product 다수 + background 1) 조합 수용 가능.

### 완료 조건

```python
valid[2] = valid[1] and bool(state.composition.imageUrl)
```

### 출력

```typescript
state.composition = {
    imageUrl: string,             // 서버 저장된 안정 URL — FlashTalk 입력으로 전달
    hostRef: string,              // state.host.imageUrl 스냅샷
    productRefs: string[],        // 업로드된 제품 경로
    backgroundMeta: {
        type: "preset" | "upload" | "prompt",
        value: string,
    },
    compositionPrompt: string,
}
```

---

## 호스트 재사용 (저장소)

### 저장 트리거

Stage 1에서 호스트 선택 후 `[내 호스트로 저장]` 버튼 (선택적).

### 저장 스키마

**서버 측 영속 저장**: 선택된 이미지를 `hosts/{hash}.png`로 copy (안정 URL 확보).

**클라이언트 localStorage**:
```typescript
localStorage["saved_hosts"] = [
    {
        id: string,                 // UUID
        name: string,                // 사용자 입력, 기본 "호스트 1"
        thumbnailUrl: string,        // /hosts/{hash}.png
        imageUrl: string,            // /hosts/{hash}.png
        sourceMethod: string,
        createdAt: ISO8601,
        metadata: { prompt?, refs?, ... }
    },
    ...
]
```

### 재사용 흐름

Stage 1에서 `[저장된 호스트]` 탭 → 드롭다운/그리드에서 선택 → `state.host` 즉시 채움 → `valid[1] === true` → 바로 Stage 2로.

### 왜 서버 영속 저장인가

`uploads/`는 temp 성격이라 서버 청소/재시작 시 파일 유실 → 저장된 호스트 이미지 404. `hosts/` 영속 디렉토리에 copy하면 안정적 URL 보장.

V2에서 계정 연동 시: `localStorage` → 서버 DB로 migration.

---

## 백엔드 API (추가/수정)

| 메서드 | 경로 | 역할 |
|---|---|---|
| POST | `/api/host/generate` | Stage 1 호스트 생성 (N=4) — `method: text|face-outfit|style-ref`, 필요 입력값 |
| POST | `/api/host/generate-one-more` | 기존 4장에 1장 추가 생성 |
| POST | `/api/host/save` | 선택된 호스트를 `hosts/`로 영속화 |
| GET | `/api/host/list` | 저장된 호스트 목록 (현재 세션 기준 — V2에서 계정별) |
| DELETE | `/api/host/{id}` | 저장된 호스트 삭제 |
| POST | `/api/composition/generate` | Stage 2 합성 이미지 생성 (N=4) |
| POST | `/api/composition/generate-one-more` | 합성 이미지 +1 |
| POST | `/api/upload/product` | 제품 업로드 + 자동 rembg (처리 결과 썸네일 반환) |

기존 `/api/elevenlabs/*`, FlashTalk 영상 생성 엔드포인트는 변경 없음 (Stage 3 진입 시 `state.composition.imageUrl`을 host 이미지로 사용).

---

## 프론트엔드 컴포넌트 (신규/수정)

| 컴포넌트 | 역할 |
|---|---|
| `TopBar.jsx` | 3단계 진행 배지 (1.호스트 / 2.합성 / 3.영상), `valid[]` 기반 활성 상태 |
| `HostMaker.jsx` (신규) | Stage 1 전체 — 4개 탭, 후보 그리드, 선택, 저장 |
| `HostMaker/TextMethod.jsx` | 1-1 |
| `HostMaker/FaceOutfitMethod.jsx` | 1-2 |
| `HostMaker/StyleRefMethod.jsx` | 1-3 |
| `HostMaker/SavedHosts.jsx` | 1-4 + `localStorage` 관리 |
| `HostMaker/CandidateGrid.jsx` | N=4 2×2 그리드, 선택 상태 |
| `SceneComposer.jsx` (신규) | Stage 2 — 제품 업로드, 배경 선택, 구도 입력, 후보 그리드 |
| `SceneComposer/ProductUploader.jsx` | 다수 업로드, rembg 토글, 썸네일 |
| `SceneComposer/BackgroundPicker.jsx` | 프리셋/업로드/프롬프트 3방식 |
| `VideoGenerator.jsx` (기존 수정) | Stage 3 — `state.composition.imageUrl`을 host 이미지로 사용 |

기존 `VideoGenerator.jsx`의 "호스트 이미지 업로드" UI는 Stage 1에 흡수되고, Stage 3에서는 Stage 2 합성 결과를 자동 수신하도록 변경.

---

## V2 (후속) 이관 항목

- 제품 URL 입력 (+ 자동 대표 이미지 추출)
- 배경 URL 입력
- 호스트 저장소 계정 연동 (서버 DB)
- 공개 호스트 라이브러리 (다른 사용자 호스트 탐색)
- 구도 선택을 구조화 UI로 승격 (옵션)
- 멀티 스피커 대화 모드(`ConversationGenerator`) 파이프라인 통합

---

## 결정 내역 (의사결정 로그)

### R1. 얼굴 identity 드리프트
**결정: 별도 대응 없음.**
Stage 1의 모든 입력이 AI 재생성을 거치고, Stage 2 image-to-image에서 한 번 더 재해석됨. FlashTalk은 항상 AI 생성물을 받으므로 "원본 보존" 기대 자체가 파이프라인 구조상 발생하지 않음.

### I1. N=4 후보 생성
**결정: 병렬 호출 (asyncio.gather).**
Gemini image gen API가 native batch 미지원. Batch API(24h 지연)는 UX 불가. 병렬 호출 시 레이턴시는 단일과 유사, 비용만 선형 증가. "1장만 더 뽑기"는 +1회 호출.

### I2. 호스트 저장 방식
**결정: 서버 `hosts/` 영속 디렉토리 + `localStorage` 메타데이터.**
`uploads/` temp 특성으로 인한 URL 불안정을 회피. 이미지는 서버 영속 저장, 클라는 메타만 보관. V2 계정 연동 시 migration 용이.

### 모델 선택
**결정: `gemini-3.1-flash-image-preview` (Nano Banana 2)로 다운그레이드.**
현재 `gemini-3-pro-image-preview`(Nano Banana Pro)는 복잡한 타이포/전문 에셋용으로 스펙 과잉. Flash Image 2가 속도/비용 면에서 유리하고 본 파이프라인에 적합. 품질 A/B 샘플 10개씩으로 선판정.

### 제품/배경 URL 입력
**결정: V1 drop, V2 고려.**
URL 처리는 CORS/인증/링크 만료 등 실패 지점 다수. V1은 업로드 집중.

### 후보 개수 N
**결정: N=4 고정.**
2×2 그리드 UI 적합, 선택 피로도 낮음, 비용 예측 용이.

### 구도 입력
**결정: 자유 텍스트 + 예시 칩.**
구조화 UI(좌표/슬롯) 구현 비용 대비 실익 낮음. Gemini 자연어 구도 이해 우수.

### 제품 전처리
**결정: 자동 rembg (기본 ON), 체크박스로 OFF 가능.**
대부분 깨끗한 제품 사진 가정 시 자동 처리가 품질에 유리. 플레이팅/인테리어 샷 예외는 OFF로 커버.

---

## Open Questions (구현 시 결정)

1. **`hosts/` 디렉토리 용량 관리** — 사용자당 저장 호스트 상한선? LRU 청소 정책?
2. **제품 업로드 최대 개수** — Gemini 14장 제한을 고려해 제품 N ≤ 10 정도로 UI 제한?
3. **Gemini 실패 시 fallback** — 후보 4장 중 일부 실패 시 재시도? 성공한 것만 표시?
4. **`[다시 뽑기]` 시 이전 후보 히스토리 유지** — 무한 저장? 직전 세트만?
5. **배경 프리셋 목록** — "스튜디오/거실/주방/매장" 등 몇 개를 V1에 담을지?

## 다음 단계

1. 본 문서 리뷰 및 확정
2. `specs/pipeline-v2/spec.md` 작성 (API 시그니처, 상태 스키마 상세)
3. 백엔드 엔드포인트 프로토타입 (Stage 1 먼저)
4. 프론트엔드 `HostMaker` 컴포넌트 구현
5. E2E 통합 테스트 (Stage 1 → 2 → 3 흐름)
