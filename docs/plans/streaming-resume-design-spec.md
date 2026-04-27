# Streaming Resume — Design Spec

**Branch:** `feat/streaming-resume`
**Companion to:** `streaming-resume-plan.md` (v2 reframe)
**Date:** 2026-04-27
**Status:** Design spec phase (autoplan Phase 2 가 요구한 6 artifact)

이 문서는 plan v2의 design 미세화. plan은 무엇을 만들지, 이 문서는 어떻게 보일지.

---

## 1. 7 상태 wireframe

Step 1 우측 캔버스 기준. Step 2 합성 캔버스도 같은 패턴. 좌측 form은 스펙 변경 없음(disabled toggling만).

### 1.1 `idle` — 시작 전
```
┌──────────────────────────────────────────────┐
│ EYEBROW: 오디션 결과                          │
│ TITLE  : 쇼호스트 후보가 여기 나와요           │
│ ──────────────────────────────────────────── │
│                                              │
│         ┌────────┐                           │
│         │ 🖼️       │  ImageOff icon 24px      │
│         └────────┘                           │
│                                              │
│   왼쪽에 어떤 모습인지 적고                    │
│   쇼호스트 만들기를 눌러주세요                 │
│                                              │
│   (text-tertiary, leading-1.55)              │
└──────────────────────────────────────────────┘
```
- TopBar pill: 숨김 또는 dim
- Footer: 없음
- a11y: container `aria-label="쇼호스트 후보 비어있음"` `aria-live="off"`

### 1.2 `attached_loading_snapshot` — 1-2초 fetch 구간 (NEW)
복귀/reload 직후 `GET /api/jobs/:id` 응답 대기 중.

```
┌──────────────────────────────────────────────┐
│ EYEBROW: 오디션 결과 · 복귀 중                 │
│ TITLE  : 잠시만요, 작업을 불러오고 있어요       │
│ ──────────────────────────────────────────── │
│                                              │
│  ┌───┐ ┌───┐ ┌───┐ ┌───┐  [ ┌───┐ ]          │
│  │░░░│ │░░░│ │░░░│ │░░░│    │prv│  ← prev    │
│  │░░░│ │░░░│ │░░░│ │░░░│    │ A │  full opc  │
│  └───┘ └───┘ └───┘ └───┘    └───┘            │
│                                              │
│  4 skeleton tiles (shimmer)                  │
│  + prev tile from cached store snapshot      │
│  (있으면 표시, 없으면 4 grid)                  │
└──────────────────────────────────────────────┘
```
- 1.5초 안에 snapshot 도착하면 곧바로 §1.3 또는 §1.4로 전환 (사용자 거의 못 느낌)
- 1.5초+: inline status 등장 "잠시만요…"
- TopBar pill: **grey pulsing dot** (snapshot 모르므로 아직 빨강 X)
- Skeleton 색: `bg-secondary`, shimmer keyframe 1.4s linear infinite
- a11y: container `aria-busy="true"`, live region "작업을 불러오고 있어요" (polite, 1초 지연)

### 1.3 `streaming` — 진행 중
```
┌──────────────────────────────────────────────┐
│ EYEBROW: 오디션 결과 · 진행 중 2/4              │
│ TITLE  : 후보를 만드는 중이에요                 │
│ ──────────────────────────────────────────── │
│                                              │
│  ┌───┐ ┌───┐ ┌───┐ ┌───┐  ┌───┐              │
│  │ ✓ │ │ ✓ │ │░░░│ │░░░│  │prv│              │
│  │이미│ │이미│ │░░░│ │░░░│  │ A │              │
│  └───┘ └───┘ └───┘ └───┘  └───┘              │
│  full   full  skeleton  dashed-border        │
│                                              │
│  도착 candidate: scale 0.96→1.0 + opacity    │
│   0→1, 220ms ease-out (single fade-in)       │
└──────────────────────────────────────────────┘
```
- 도착한 신규 = full color, hover halo 가능
- 미도착 placeholder = skeleton shimmer (위와 동일)
- prev = 항상 5번째, **dashed border** + 우상단 small badge "이전"
- visual rank: 신규(primary) > prev(secondary, 75% opacity까지 dim 권장)
- TopBar pill: 빨간 dot + ring spinner + "2/4" subtext
- Footer: 없음 (선택은 ready 상태에서만)
- a11y: live region "1번째 후보 도착", "2번째 후보 도착" 매 evt
- 변경 사항이 있을 때 focus는 절대 자동 이동 X

### 1.4 `ready` — 완료
```
┌──────────────────────────────────────────────┐
│ EYEBROW: 오디션 결과 · 4장 완료                │
│ TITLE  : 마음에 드는 한 명을 골라주세요          │
│ ──────────────────────────────────────────── │
│                                              │
│  ┌───┐ ┌───┐ ┌◉──┐ ┌───┐  ┌───┐              │
│  │ A │ │ B │ │ C │ │ D │  │prv│              │
│  │   │ │   │ │sel│ │   │  │ A │              │
│  └───┘ └───┘ └───┘ └───┘  └─ ─┘              │
│   new   new   sel   new    dashed (이전)      │
│                                              │
│  ─────────────────────────────────           │
│  ✓ 선택 완료 · 다음 단계로 넘어가세요           │
│         [다시 만들기]                         │
└──────────────────────────────────────────────┘
```
- 4 신규 = full color, primary rank
- 선택된 것 = `border-primary border-2` + 좌상단 체크 표시
- prev = `border-dashed border-rule-strong`, opacity 75%, "이전" badge 유지
- 자동 선택 안 함. 사용자 명시 클릭 시 selected 상태로
- footer 우측에 "다시 만들기" — re-roll 트리거
- TopBar pill: 조용 (10초 후 사라짐)

### 1.5 `failed` — 실패
```
┌──────────────────────────────────────────────┐
│ EYEBROW: 오디션 결과 · 실패                    │
│ TITLE  : 일부 후보가 만들어지지 않았어요         │
│ ──────────────────────────────────────────── │
│                                              │
│  ┌───┐ ┌───┐ ┌───┐ ┌───┐  ┌───┐              │
│  │ A │ │ B │ │ ⚠️ │ │ ⚠️ │  │prv│              │
│  │   │ │   │ │실패│ │실패│  │ A │              │
│  └───┘ └───┘ └───┘ └───┘  └─ ─┘              │
│  full  full   error  error  dashed           │
│                                              │
│  banner: "네트워크 문제로 일부 후보가 끊겼어요" │
│  [다시 시도] (primary)                        │
└──────────────────────────────────────────────┘
```
- 도착한 candidate는 그대로 사용 가능
- 실패 slot: red soft bg + alert_circle + "실패" label
- prev: 그대로 살아있음 (실패에도 prev는 안 사라짐)
- TopBar pill: 빨강에서 회색으로 (작업 종료 신호) + 5초 후 dismiss
- a11y: alert role + assertive live "후보 만들기 일부 실패. 다시 시도 버튼이 화면 중앙에 있어요"

### 1.6 `interrupted_by_reload` — 새로고침 직후 (대안: 단순 ready) (NEW)
v2 reframe로 server-side에서 작업 살아있다면 reload는 그냥 §1.2 → §1.3/§1.4로 자연 전이. 별도 상태 필요 없음.

만약 server-side에서 cancelled로 mark되어 있다면 (e.g. v8→v9 마이그레이션 후 stale streaming) §1.7 cross-device-cancelled 패턴 사용.

### 1.7 `cross_device_pickup` — 다른 기기에서 시작 (NEW)
```
┌──────────────────────────────────────────────┐
│ EYEBROW: 오디션 결과 · 다른 기기에서 시작        │
│ TITLE  : 다른 기기에서 시작한 작업을 이어 받았어요│
│ ──────────────────────────────────────────── │
│                                              │
│  (state는 streaming 또는 ready와 동일하게 표시) │
│                                              │
│  ↑ Toast 우상단 (5초 자동 dismiss):           │
│  ┌────────────────────────────────────────┐ │
│  │ 📱 다른 기기에서 시작한 쇼호스트 작업       │ │
│  │   3분 전 시작 · 4장 중 2장 완료              │ │
│  │                              [확인]       │ │
│  └────────────────────────────────────────┘ │
│                                              │
└──────────────────────────────────────────────┘
```
- 첫 fetch 시 server `remote_origin: true` 플래그 (last SSE subscriber와 다른 client_id)
- toast: 정보성, 강제 dismiss 아님, 5초 자동
- 클릭 시 grid로 scroll, 그것만
- TopBar pill: 일반 streaming/ready 상태 그대로

---

## 2. TopBar pill micro-spec

### 2.1 Closed (기본 상태)
| 작업 수 | Pill 모양 |
|---|---|
| 0 | 숨김. wizard footer 자체 없음 |
| 1 streaming | 작은 conic-gradient ring spinner + "2/4" text + light pulse |
| 1 ready (다른 step) | green check dot + "준비됨" 1회 pulse 후 fade |
| 2+ streaming | stacked dots (host=primary, composite=accent), 숫자 badge "2" |
| 1 failed (다른 step) | red dot + 작은 "!", 5초 자동 dismiss |

### 2.2 Hover/click expanded panel
shadcn Popover 사용. align="end", sideOffset=6.

```
┌──────────────────────────────────┐
│ 진행 중인 작업              [✕]    │
│ ─────────────────────────────────│
│                                   │
│ ● Step 1 쇼호스트          (host) │
│   ━━━━━━━━━━░░░░░ 60% · ~20초     │
│   "30대 여성, 밝게…"               │
│   [열기] [취소]                    │
│                                   │
│ ✓ Step 2 제품 합성     1분 전 완료 │
│   [확인하러 가기]                   │
│                                   │
│ × Step 1 쇼호스트     5분 전 실패  │
│   "네트워크 끊김"                   │
│   [재시도] [숨기기]                 │
└──────────────────────────────────┘
```

- 진행률 계산: `variants.filter(v => !v.placeholder).length / 4`
- ETA: 평균 candidate 시간(history 기반, 없으면 표시 안 함)
- 취소: confirm 없이 바로 DELETE + 5초 undo toast (§3 참고)
- click outside / ESC = 닫기
- a11y: `role="dialog"` `aria-haspopup` `aria-expanded`, 첫 focus는 첫 [열기] 버튼

### 2.3 Closed → Open transition
- pill 클릭 시 220ms scale 0.95→1.0 + opacity 0→1
- panel 안 list item: stagger fade-in 30ms 간격

### 2.4 Multi-job 시각 규칙
- host job + composite job 동시 streaming → stacked dots, 숫자 badge "2"
- 같은 kind 두 개는 불가 (slice당 single in-flight, 새 start = old DELETE)
- 다음 PR(v2.1)에서 N parallel 시 panel item 단순 추가

---

## 3. Cancel & Undo flow

### 3.1 Re-roll (다시 만들기)
**Job streaming 중 클릭 시:**
```
┌─────────────────────────────────────────┐
│ 진행 중인 작업을 취소하고 새로 시작할까요?  │
│ 지금까지 만들어진 후보는 사라져요          │
│                                          │
│              [취소]    [새로 만들기]      │
└─────────────────────────────────────────┘
```
- shadcn AlertDialog (focus trap)
- 사용자 "새로 만들기" → 1st Job DELETE + 2nd Job POST 동시 발사 (race 무시 — server에서 idempotent)
- 사용자 "취소" → modal 닫고 그대로 streaming

**Job ready에서 클릭 시:**
- confirm 없음. "다시 만들기" 즉시 새 Job. 이전 Job의 selected는 prev로 1장 살아남음.

### 3.2 Mid-stream cancel (TopBar panel "[취소]" 버튼)
```
1. 즉시 UI: streaming tiles에 50% opacity overlay + "취소 중…" inline
2. DELETE 발사
3. server 'cancelled' evt 도착 (보통 200ms 안)
4. Toast 우하단 (4초):
   ┌────────────────────────────────────┐
   │ 작업 취소됨               [되돌리기]  │
   │ 지금까지 만들어진 후보는 history에   │
   └────────────────────────────────────┘
5. 4초 안에 "되돌리기" 클릭 → POST 재발사 (같은 input_blob)
6. 4초 후 toast dismiss + grid에서 partial 제거
```
- Server: cancelled Job도 row 보존 (state='cancelled', variants 그대로). v2.1 history에서 retrieve 가능.
- a11y: toast `role="alert"`, hover/focus 시 timer pause

### 3.3 Cross-tab cancel (다른 탭에서 새로 시작했을 때)
Tab1 SSE evt='cancelled' (`reason: replaced_by_other_tab`) 수신:
```
1. grid에 soft fade-out 400ms
2. inline message:
   "이 작업은 다른 탭에서 새로 시작한 것으로 대체됐어요"
   [확인]
3. 5초 자동 dismiss 또는 사용자 클릭
4. idle로 복귀
```

---

## 4. Motion spec

| 요소 | Trigger | Duration | Easing | 비고 |
|---|---|---|---|---|
| Variant fade-in | candidate evt 도착 | 220ms | ease-out | scale 0.96→1.0 + opacity 0→1 |
| Skeleton shimmer | streaming/loading | 1.4s loop | linear | gradient 위치 -100% → 200% |
| TopBar pill ring spinner | streaming | 1.0s loop | linear | conic-gradient rotate 0→360 |
| Pill state morph (closed→open) | hover/click | 220ms | cubic(0.2,0.8,0.2,1) | scale + opacity |
| Panel item stagger | panel 열림 | 30ms 간격 × N | ease-out | 마지막 item은 N×30ms 지연 |
| Toast slide-in | toast 등장 | 280ms | cubic(0.2,0.8,0.2,1) | translateY 12px→0 + opacity |
| Cancel overlay | DELETE 클릭 | 120ms | linear | opacity 0→0.5 |
| Failed alert pulse | failed 진입 | 600ms × 1 | ease-out | scale 1.0→1.05→1.0 (1회만) |
| Cross-tab fade-out | replaced_by_other_tab | 400ms | ease-in | opacity 1→0 |

`prefers-reduced-motion`: shimmer/spinner는 단색 fill로, 그 외 모션은 즉시 (duration 0).

---

## 5. Copy deck (Korean micro-copy)

### 5.1 상태별 (eyebrow + title)
| 상태 | Eyebrow | Title |
|---|---|---|
| idle | 오디션 결과 | 쇼호스트 후보가 여기 나와요 |
| attached_loading_snapshot | 오디션 결과 · 복귀 중 | 잠시만요, 작업을 불러오고 있어요 |
| streaming | 오디션 결과 · 진행 중 N/4 | 후보를 만드는 중이에요 |
| ready | 오디션 결과 · 4장 완료 | 마음에 드는 한 명을 골라주세요 |
| failed | 오디션 결과 · 실패 | 일부 후보가 만들어지지 않았어요 |
| cross_device_pickup | 오디션 결과 · 다른 기기에서 시작 | 다른 기기에서 시작한 작업을 이어 받았어요 |

(Step 2 합성 캔버스는 "오디션 결과" → "합성 결과", "쇼호스트" → "합성 결과/제품"으로 치환)

### 5.2 마이크로 카피
| 위치 | 카피 |
|---|---|
| Idle empty illustration | 왼쪽에 어떤 모습인지 적고 / 쇼호스트 만들기를 눌러주세요 |
| Loading 1.5초+ inline | 잠시만요, 작업을 불러오고 있어요 |
| Streaming live region | N번째 후보 도착 |
| Ready footer (선택 전) | 마음에 드는 한 명을 골라주세요 |
| Ready footer (선택 후) | ✓ 선택 완료 · 다음 단계로 넘어가세요 |
| Failed banner | 네트워크 문제로 일부 후보가 끊겼어요 |
| Re-roll confirm | 진행 중인 작업을 취소하고 새로 시작할까요? \\ 지금까지 만들어진 후보는 사라져요 |
| Cancel toast | 작업 취소됨 · 지금까지 만들어진 후보는 history에 |
| Cross-tab replaced | 이 작업은 다른 탭에서 새로 시작한 것으로 대체됐어요 |
| Cross-device toast | 📱 다른 기기에서 시작한 쇼호스트 작업 · 3분 전 시작 · 4장 중 2장 완료 |
| TopBar pill ETA | ~20초 (없으면 표시 안 함) |
| TopBar item action | [열기] [취소] [재시도] [숨기기] |
| Re-roll button | [다시 만들기] |

### 5.3 카피 원칙
- 부정형 회피: "사라졌어요"보다 "history에 보존되어 있어요"
- 사용자 행동 기준: "후보가 도착했어요"보다 "마음에 드는 한 명을 골라주세요"
- "오류" 같은 추상명사보다 구체적 원인: "네트워크 문제로", "잠시 끊겼어요"

---

## 6. Accessibility spec

### 6.1 Live region (전역 1개, wizard 안에서 공유)
```tsx
<div role="status" aria-live="polite" aria-atomic="false" className="sr-only" />
```
업데이트:
| Event | 카피 |
|---|---|
| Stream start | 쇼호스트 후보 만들기 시작 |
| Each candidate (1~4) | N번째 후보 도착 |
| Stream done | 후보 4장 준비 완료. Tab 키로 후보 목록에 진입하세요 |
| Stream failed | 후보 만들기 실패. 다시 시도 버튼이 화면 중앙에 있어요 |
| Mid-bg done (다른 step) | Step 1 후보 준비 완료, 위 진행 표시에서 확인하세요 |
| Cross-device pickup | 다른 기기에서 시작한 작업을 이어 받았어요 |

`aria-live="assertive"` + `role="alert"` — cancel toast와 cross-tab replaced 메시지만.

### 6.2 Keyboard nav (HostVariantGrid · CompositionVariants)
- container: `role="radiogroup" aria-label="쇼호스트 후보"`
- 각 tile: `role="radio" aria-checked={selected}`
- roving tabindex: 화살표 좌/우/상/하로 이동, Tab은 grid 진입/이탈
- Space/Enter = 선택
- Esc = 포커스 unset (focus 다음 step nav으로 이동)

### 6.3 Focus management
- 신규 candidate streaming 도착 시 focus 절대 자동 이동 X
- ready 진입 시 focus는 그대로 form 영역에 둠 (사용자 의도와 무관한 점프 방지)
- failed 진입 시 focus를 banner의 "다시 시도" 버튼으로 이동 (단, 사용자가 form에 typing 중이면 X — `document.activeElement` 체크)
- TopBar panel 열림 시 첫 [열기] 버튼에 focus

### 6.4 Toast/Modal a11y
- Toast: `role="alert"` (assertive), 5초 timeout이지만 hover/focus 시 timer pause
- Modal (re-roll confirm): focus trap, Esc로 닫기, 첫 focus는 [취소] 버튼 (안전한 default)

### 6.5 Color/contrast
- TopBar pill 빨간 dot은 색상만으로 의미 전달 X. dot 옆에 항상 "N/4" 같은 text 또는 sr-only label
- prev tile dashed border + opacity 75% — 색맹 사용자도 신규/이전 구분 가능 (border style 차이가 일차 신호)
- error tile alert_circle icon + "실패" text + red border + red soft bg 4중 신호

---

## 7. 구현 체크리스트

| # | 항목 | 파일 |
|---|---|---|
| 1 | 7 상태 wireframe → 컴포넌트 매핑 | `Step1Host.tsx`, `Step2Composite.tsx`, `HostVariantGrid.tsx` |
| 2 | TopBar pill closed 5 variants | `QueueStatus.tsx`, `QueueTrigger.tsx` |
| 3 | Pill expanded panel | `QueuePanel.tsx` 재구성 (host/composite job kind 추가) |
| 4 | Re-roll confirm modal | shadcn AlertDialog 신규 |
| 5 | Mid-stream cancel toast (undo) | shadcn Toast wrapper 또는 sonner |
| 6 | Cross-device toast | 동일 toast 시스템 |
| 7 | Cross-tab replaced 메시지 | grid container inline |
| 8 | Motion spec → CSS 또는 framer-motion | `index.css` `@keyframes` 또는 framer 설치 |
| 9 | Live region | `WizardLayout.tsx` 또는 `studio-root` |
| 10 | Keyboard nav (radiogroup) | `HostVariantGrid.tsx` 재구조 |
| 11 | Copy deck → i18n table | `frontend/src/i18n/wizard-streaming.ts` 신규 |
| 12 | a11y matrix → automated test (axe-core) | `__tests__/a11y/streaming-states.test.tsx` |

---

## 8. Product 결정 반영 (2026-04-28)

- **Cancelled history 표시:** v2.1 history view에 `ready` / `failed` / `cancelled` 3 탭. cancelled 타일은 ready 타일과 동일 layout이지만 opacity 60% + "취소됨" badge (좌상단, dark grey). 클릭 시 retrieve 가능 (사용자가 "다시 쓰기" 누르면 같은 input으로 새 Job).
- **Mid-stream cancel toast 카피 (§3.2) 일관 유지:** "지금까지 만들어진 후보는 history에 보존되어 있어요"라고 명시.
- **Step 3은 별도 PR:** 본 design spec은 Step 1/2 host/composite만 다룸. Step 3 (음성·영상)은 v2.1 PR2에서 동일 패턴으로.

### Designer review에서 추후 결정 필요

- 색상: streaming 도착 candidate fade-in 시 ring/glow 효과 추가 여부
- ETA 계산: 사용자별 history 기반인지 global 평균인지 — backend가 결정. UI는 "있으면 표시" 정책
- prev tile 강조: dashed border + 75% opacity + badge 충분한가, 더 명시적 라벨 필요?
- Pill multi-job 시 panel 정렬: 시간순 (가장 최근 위) 권장
- Panel max 항목: 5개. 그 이상은 history view로 link
- cancelled 타일 hover state: "다시 쓰기" inline 버튼 vs 클릭으로 modal 진입

---

## 9. v2 plan 갱신 사항 (이 spec 작성 후 plan에 반영)
- §1 wireframe table은 본 spec §1 7 상태로 확장됨
- §5.4 UI gate 변경은 그대로 유지 (`variants.length || prevSelected`)
- §5.6 TopBar pill 강화는 본 spec §2가 구체화
- 본 spec §6 a11y는 plan에 누락됐던 항목, plan §5에 cross-reference 추가 필요

이 design spec이 implementer-ready의 design 측 충족 조건.
