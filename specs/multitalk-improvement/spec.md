# Spec: 2인 쇼호스트 대화 영상 품질 개선

## 목표
두 쇼호스트가 자연스럽게 대화하는 영상을 **FlashTalk 단일 인물 수준의 품질**로 생성.
가운데 이음새 없이 하나의 자연스러운 화면.

## 핵심 제약 조건
- GPU: 4x A100 80GB (VRAM 합계 320GB, 시스템 RAM 충분)
- FlashTalk 단일 인물 품질이 기준선 (이보다 나빠지면 안 됨)
- 생성 속도: 실시간은 아니어도 되지만 턴당 수 분 이내 허용

## 전략 비교 및 선택

### Option A: MultiTalk 최적화 (현재 접근)
- **장점**: 두 사람이 한 프레임에서 자연스럽게 상호작용
- **단점**: 480P 해상도 한계, 30배 느린 속도, FlashTalk 대비 낮은 품질
- **개선 여지**: TeaCache, INT8 양자화, 720P 모델 (존재 시)
- **위험도**: 높음 - 모델 본질적 한계 (non-distilled)

### Option B: FlashTalk 유지 + 고급 합성 (권장)
- **장점**: 인당 품질 최고, 속도 빠름, 검증된 파이프라인
- **단점**: 배경 이음새 해결 필요
- **핵심 아이디어**:
  - **공유 배경 + 개별 인물 생성 + 알파 합성**
  - 배경은 1장 생성 → 각 에이전트는 투명 배경(green screen)으로 생성 → 합성
- **위험도**: 낮음 - FlashTalk 검증된 품질 활용

### Option C: 하이브리드 (FlashTalk 생성 + AI 후처리)
- **장점**: FlashTalk 품질 + 후처리로 이음새 제거
- **단점**: 추가 모델/처리 필요
- **핵심 아이디어**:
  - FlashTalk으로 개별 생성 → inpainting 모델로 중앙 이음새 영역 보정
  - 또는 optical flow 기반 seamless blending
- **위험도**: 중간

## 선택: Option B (FlashTalk + 알파 합성) + Option A 백업

### 이유
1. FlashTalk의 품질과 속도를 포기할 이유가 없음
2. MultiTalk의 480P 해상도 한계는 하드웨어가 아닌 모델 한계
3. 배경 이음새 문제는 **합성 단계**에서 해결 가능
4. MultiTalk은 향후 720P 모델 출시 시 재검토

## 기능 요구사항

### Phase 1: FlashTalk + Seamless Background (핵심)
1. **공유 배경 생성**: Gemini로 전체 배경 1장 생성 (두 사람 없이, 배경만) ✅ 구현 완료
2. **개별 인물 생성**: FlashTalk으로 에이전트별 영상 생성 (기존 품질 유지) ✅ 구현 완료
3. **배경 분리**: 생성된 영상에서 rembg로 프레임별 인물 추출 ✅ 구현 완료 → ⚠️ 반투명 문제 발생
4. **알파 합성**: 공유 배경 위에 두 인물을 합성 → 이음새 완전 제거 ✅ 구현 완료 → ⚠️ 반투명 문제
5. **오디오 동기화**: 기존 conversation_compositor 로직 유지 ✅ 구현 완료

### Phase 1.5: Alpha Matting 품질 수정 (긴급)
> 문제: 배경은 정상이지만 사람이 반투명하게 거의 보이지 않음

1. **Alpha 후처리 추가**: rembg 출력 alpha를 threshold + boost 처리
   - 약한 alpha (150~200) → 완전 불투명 (255)로 강화
   - 배경 잔여 (0~30) → 완전 투명 (0)으로 제거
   - soft edge 유지를 위한 중간 영역 스무딩
2. **rembg 모델 변경**: `u2net` → `u2net_human_seg` (인체 전용 모델)
3. **FlashTalk 입력 배경 단순화**: 복잡한 Gemini 배경 대신 **단색 배경** (예: 순수 녹색/회색)으로 FlashTalk에 전달 → 인물 추출 정확도 대폭 향상
4. **디버그 출력**: matting 결과를 중간 파일로 저장하여 품질 확인 가능하게

### Phase 2: MultiTalk 최적화 (백업/향후)
1. **TeaCache 적용**: 중복 step 캐싱으로 2-3배 속도 향상
2. **INT8 양자화**: dit_model_int8.safetensors 활용으로 VRAM/속도 개선
3. **해상도 실험**: 720P 버킷 사용 가능 여부 테스트
4. **MultiTalk 720P 모델 대기**: MeiGen-AI에서 720P 모델 출시 시 교체

## 비기능 요구사항
- FlashTalk 단독 사용 시 기존 기능 영향 없음
- UI에서 MultiTalk/FlashTalk 합성 모드 선택 가능
- 에러 시 FlashTalk hstack 방식으로 자동 fallback
