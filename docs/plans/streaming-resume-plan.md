# Streaming Resume — 자연스러운 생성형 파이프라인 UX

**Branch:** `feat/streaming-resume`
**Author:** jack-buzzni (with Claude)
**Date:** 2026-04-27
**Status:** Draft (pending /plan-design-review + /plan-eng-review)

---

## 0. 문제와 사용자 의도

Step 1(쇼호스트 후보)·Step 2(합성 후보)에서 두 회귀가 보였습니다.

- **A.** "다시 만들기"를 누르는 순간 5번째 "이전 선택" 타일이 사라졌다가, 첫 placeholder 도착 후에야 다시 뜸.
- **B.** 생성 중에 "다음 단계"로 이동했다 돌아오면 진행 중이던 stream이 끊기고, 이전 선택 타일도 빈 상태로 돌아옴.

사용자 한 줄 요지:
> 당연히 요청하고 나서 다른 단계에 갔다와도 생성 중이어야 하지 않겠어?

이 plan은 그 질문을 **"생성형 파이프라인이 wizard 어디로 이동해도 백그라운드에서 살아 있는 자연스러운 UIUX flow"**로 일반화해 다시 짭니다.

---

## 1. UX Vision — 사용자 mental model

> **"내 생성 작업은 어딘가에서 살아 있다. 어디로 이동하든 따라오고, 끝나면 알려주고, 결과는 어디서든 다시 꺼내 볼 수 있다."**

이 mental model 하나가 결정의 기준입니다. 화면을 떠난다고 작업이 죽지 않고, 화면에 와야만 진행이 보이지 않고, 완료가 알림 없이 사라지지 않습니다.

### 우리 wizard에 대입하면
| 사용자가 한 것 | 보여줘야 할 것 | 보여서는 안 되는 것 |
|---|---|---|
| "쇼호스트 만들기" 클릭 (생성 시작) | placeholder 4개 즉시(낙관적 UI), prev 5번째 타일 그대로 | 빈 우측 패널, prev 타일 사라짐 |
| Step 2로 이동 | TopBar "작업" pill에 빨간 dot · 진행률 | 조용히 사라짐 |
| Step 1로 복귀 | streaming 그대로 이어 받음. 이미 도착한 결과 + placeholder 나머지 | "다시 만들기 누르세요" 같은 idle |
| 새로고침 (드물게) | idle로 reset (현재와 동일, 안전한 fallback) | 자칫 zombie streaming |
| 페이지 닫음 → 나중에 복귀 | 마지막 ready 결과 + prev 그대로 | 빈 그리드 |
| 도중에 다시 "다시 만들기" | 옛 스트림 abort, prev는 유지, 새 placeholder | prev 사라짐, 옛 결과 잔재 |

### 생성형 파이프라인 패턴 reference
- **Midjourney**: Discord/web 모두 4-grid 결과 + variation/upscale 마이크로 액션. 작업은 queue 위에 살아 있고, 사용자는 다른 prompt를 던지러 다른 채널/페이지로 이동해도 결과는 history에 자동 적재됨.
- **Sora**: 라이브러리 중심 — 사용자가 prompt 던지면 카드가 라이브러리에 즉시 생기고, 카드 위에서 진행률·완료 알림. 사용자 view는 자유롭게 이동.
- **ChatGPT image / DALL-E**: 메시지 인라인에 progress + 결과. 새 메시지 보내도 진행 중인 이미지는 그 자리에서 계속 갱신됨.
- **Runway**: project 단위 history. 모든 generation은 timestamp · tag로 history에 살아 있음. 사용자는 generation 진행 중에 다른 project를 편집 가능.

공통 원칙:
1. **낙관적 UI**: 시작 즉시 자리(placeholder)를 잡아 "생성이 시작됐다"는 신호를 시각화.
2. **백그라운드 영속성**: 작업의 lifecycle은 view의 lifecycle보다 길다.
3. **항상 보이는 진행 신호**: persistent indicator (banner/pill/dot).
4. **다시 꺼낼 수 있는 history**: 끝난 작업은 동일 화면 또는 별도 history에서 재방문 가능.

우리 wizard는 1·3은 부분적, 2·4는 미흡. 이 plan으로 모두 잡습니다.

### 2026 UX 트렌드와의 정합
- **Stage-loading (skeleton → critical → images → non-critical)** — 우리는 placeholder 4개를 stage 1에 둠
- **Persistent vs contextual elements 균형** — TopBar 작업 pill = persistent; 후보 그리드 = contextual
- **Transparency** — stage 라벨 ("쇼호스트 다듬는 중", "후보 합성 중") 이미 있음, 강화

---

## 2. Ideal end-to-end flow (wireframe in prose)

### Flow 1 — 처음 사용 (cold start)
```
[Step 1 idle]
 좌: 입력 폼 비어있음
 우: empty illustration ("왼쪽에 적고 만들기 누르세요")
 TopBar 작업 pill: 비활성

→ 사용자 입력 + "쇼호스트 만들기"

[Step 1 streaming]  
 좌: 폼 disabled, 버튼 "만드는 중…" + spinner
 우: placeholder 4개 즉시 (skeleton shimmer + 9:16 비율)
 TopBar 작업 pill: 빨간 dot, 진행률 (% or 단계 라벨)

→ candidate 1개 도착

[Step 1 streaming partial]
 우: 첫 타일은 실제 이미지, 나머지 3은 placeholder

→ 4번째 도착 + done

[Step 1 ready]
 좌: 폼 + 버튼 "다시 만들기"
 우: 후보 4 + (있으면) prev 5번째
 footer: "마음에 드는 한 명 골라주세요"
 TopBar pill: 조용해짐 (점 사라짐)
```

### Flow 2 — 중간에 "다시 만들기" (re-roll, 핵심 시나리오)
```
[Step 1 ready, prev=null, variants=[A,B,C,D], selected=A]

→ "다시 만들기" 클릭

[Step 1 streaming]
 우: placeholder 4개 + **5번째에 A (prev)**  ← 절대 사라지면 안 됨
 footer: "더 마음에 드는 후보 나오면 골라주세요"

→ candidate들 도착, 사용자가 첫 번째 마음에 안 들면 prev A 다시 선택 가능

[Step 1 ready, prev=A, variants=[E,F,G,H], selected=A or one of new]
```

### Flow 3 — Step 이동 round-trip (옵션 2 핵심)
```
[Step 1 streaming, prev=A]
 우: placeholder 4 + prev A

→ 사용자 "다음 단계" 클릭

[Step 2]
 우: Step 2 자체 미리보기 (별도)
 TopBar pill: **여전히 빨간 dot** ← Step 1 stream이 살아 있다는 신호
 (사용자가 pill 누르면 panel: "Step 1 진행 중 · 60%")

→ Step 1 stream의 done 이벤트 도착 (사용자가 Step 2에 있는 동안)

[Step 2]
 TopBar pill: 점 사라짐, 잠깐 success state
 toast/통지: "쇼호스트 후보 4장 준비됐어요" (선택, 5초 자동 사라짐)

→ 사용자 "이전" 클릭

[Step 1 ready]
 우: ready 결과 그대로 (prev A + 새 4개)
```

### Flow 4 — 새로고침 (fallback)
```
[Step 1 streaming, prev=A]

→ Cmd-R

[Step 1 idle]  ← 안전 fallback (live SSE 살릴 수 없음)
 우: empty
 (개선 옵션: 마지막 ready 상태로 hydrate해 prev=A 유지 — 향후 별도 PR)
```

### Flow 5 — 동시 두 stream (race)
```
[Step 1 streaming]

→ 사용자 다시 "다시 만들기" 더블클릭 또는 빠르게 두 번

→ 1st abort, 2nd start. prev는 그대로. variants 다시 placeholder 4개.
   (worker는 slice 당 single in-flight 보장)
```

### Flow 6 — 에러
```
[Step 1 streaming]

→ network drop / fatal event

[Step 1 failed]
 우: 4개 자리 중 일부는 error tile, 일부는 ready candidate (있으면)
 banner: "일부 후보가 만들어지지 않았어요. 다시 만들기"
 prev: 그대로
```

---

## 3. 핵심 결정 — single source of truth는 store

오늘은 lifecycle이 두 곳에 흩어져 있습니다.
- `useHostGeneration` 안의 `useState` (component-bound)
- `wizardStore.host.generation` (persisted)

이 이중성이 **버그 A·B 모두의 뿌리**입니다. component가 unmount되면 hook의 state는 사라지고, store는 streaming인 채로 좀비. 다시 mount되면 hook은 store에서 못 읽어와서 (`state !== 'ready'` 가드) 빈 상태로 출발.

**결정:** lifecycle을 **store + module-level worker** 한 곳으로 옮긴다. component는 read-only renderer가 된다.

```
            ┌──────────────────────────────────────────────┐
            │  wizardStore.host.generation (single SoT)    │
            │  state: idle | streaming | ready | failed    │
            │  + prevSelected (streaming도 가짐)            │
            └────▲──────────────────┬──────────────────────┘
                 │ writes           │ reads (selectors)
                 │                  ▼
   ┌──────────────────────┐    ┌────────────────────────┐
   │ hostStreamWorker      │    │ Step1Host (renderer)   │
   │ (module singleton)    │    │ — useStore(selector)   │
   │  - AbortController    │    │ — dispatch(start/abort)│
   │  - streamHost() 소비  │    └────────────────────────┘
   │  - HMR-safe cleanup   │    ┌────────────────────────┐
   └───────────────────────┘    │ TopBar 작업 pill       │
                                │ — store에서 단순 read  │
                                └────────────────────────┘
```

Worker는 **slice 당 한 개** (host용·composite용 각 1). 새 start는 옛 worker abort. 사용자는 한 번에 하나만 진행.

---

## 4. Schema 변경 (`frontend/src/wizard/schema.ts`)

```ts
// 변경 전
{ state: 'streaming', batchId: string|null, variants: HostVariant[] }

// 변경 후
{
  state: 'streaming',
  batchId: string|null,
  variants: HostVariant[],
  prevSelected: HostVariant | null,   // ← 추가
}
```

`CompositionGenerationSchema`도 동일.

**Persist 버전 8 → 9 마이그레이션.** v8 streaming blob에 `prevSelected: null` 주입. (`onRehydrateStorage`가 streaming → idle로 어차피 즉시 scrub하므로 거의 type 만족용이지만 zod parse는 통과해야 함.)

---

## 5. Worker 모듈 (`frontend/src/stores/streamWorkers.ts` — 신규)

```ts
// 의사코드
let hostController: AbortController | null = null;

export function startHostStream(
  input: HostGenerateInput,
  seeds?: number[],
) {
  hostController?.abort();           // 옛 worker 정리
  hostController = new AbortController();

  const store = useWizardStore.getState();
  const prev = store.host.generation;
  const carryPrev = prev.state === 'ready' ? prev.selected : null;

  store.setHost(s => ({
    ...s,
    generation: {
      state: 'streaming',
      batchId: null,
      variants: [],   // placeholders는 init 이벤트에서 채움
      prevSelected: carryPrev ? toPrevTile(carryPrev) : null,
    },
  }));

  (async () => {
    try {
      for await (const evt of streamHost(input, { signal: hostController.signal })) {
        // init / candidate / done / fatal
        useWizardStore.getState().setHost(s => reduceEvent(s, evt));
      }
    } catch (e) {
      if (!isAbortError(e)) {
        useWizardStore.getState().setHost(s => ({
          ...s,
          generation: { state: 'failed', error: String(e) },
        }));
      }
    }
  })();
}

export function abortHostStream() {
  hostController?.abort();
  hostController = null;
}

// HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => abortHostStream());
}
```

(composite 동형.)

---

## 6. Hook · Component 변경

### `useHostGeneration` — 얇은 selector + dispatcher
```ts
export function useHostGeneration() {
  const generation = useWizardStore(s => s.host.generation);

  const variants = generation.state === 'streaming' || generation.state === 'ready'
    ? generation.variants : [];
  const prevSelected = (generation.state === 'streaming' || generation.state === 'ready')
    ? generation.prevSelected : null;
  const isLoading = generation.state === 'streaming';
  const error = generation.state === 'failed' ? generation.error : null;
  const batchId = (generation.state === 'streaming' || generation.state === 'ready')
    ? generation.batchId : null;

  return {
    variants, prevSelected, batchId, isLoading, error,
    regenerate: startHostStream,
    abort: abortHostStream,
  };
}
```

`useState`·`useAbortableRequest` 모두 제거. 모든 state는 store에서.

### `Step1Host.tsx:287` — gate 변경
```diff
- {variants.length > 0 && (
+ {(variants.length > 0 || prevSelected) && (
    <HostVariantGrid variants={variants} prevSelected={prevSelected} … />
  )}
```

(Step 2의 `CompositeCanvas`도 동일 패턴 적용.)

### TopBar 작업 pill — 강화 (선택)
현재도 dot+pulse가 있지만, **panel에 host/composite stream 진행 상태를 명시적으로 표시**해서 "Step 1 후보 만드는 중 · 2/4"처럼 사용자가 다른 step에서도 진행도를 볼 수 있게. 별도 enhancement, 본 PR 범위 외 가능.

---

## 7. 시나리오별 동작 검증 표

| 시나리오 | 기대 | worker | store | UI |
|---|---|---|---|---|
| cold start "쇼호스트 만들기" | placeholder 4개 즉시 | start | streaming, prev=null, variants=[] (init→placeholders) | grid 4 placeholder |
| ready 상태에서 "다시 만들기" | prev 유지 + placeholder 4 | abort+start | streaming, prev=A, variants=[] | grid 4 + prev tile |
| streaming 중 Step 2 이동 | stream 계속 | unchanged | streaming | TopBar pill 빨간 dot |
| streaming 중 복귀 | grid 그대로 이어 받음 | unchanged | streaming | grid (live) + prev |
| streaming 중 done 도달 (다른 step에 있을 때) | ready 상태로 전이 | exits naturally | ready | TopBar pill 조용 |
| failed | error tile | exits | failed | grid 부분 + 에러 banner |
| 새로고침 mid-stream | idle | dispose (HMR or unload) | streaming → onRehydrate scrub → idle | empty |
| 더블클릭 "다시 만들기" | 1st abort, 2nd start | abort+start | streaming(2nd) | grid placeholder (2nd) |
| 사용자 sign-out | abort + clear | abort | reset | redirect login |

---

## 8. Test 커버리지

`frontend/src/stores/__tests__/`:

1. **`stream-workers.test.ts`** (단위)
   - start → store streaming, candidates 누적
   - second start → 1st AbortController.abort() 호출, prev 유지
   - done → ready 전이, prev streaming → ready 캐리
   - fatal → failed
   - abort 직접 호출 → idle (worker side)

2. **`streaming-prev-preservation.test.tsx`** (Bug A 회귀 테스트)
   - ready(prev=A, sel=B)에서 regenerate 호출 직후 store snapshot: prevSelected=A, variants=[]
   - placeholder가 도착하기 전에 store를 selector로 읽어도 prev=A
   - UI render: HostVariantGrid 그려져 있고 prev tile 보임

3. **`step-navigation-resume.test.tsx`** (Bug B 회귀 테스트)
   - Step1Host mount + start
   - Step1Host unmount → worker는 abort되지 않음 (store unchanged)
   - 다시 mount → store에서 streaming 그대로 read, UI 즉시 live state
   - done이 unmount 중에 도착해도 store는 ready로 전이, 다시 mount하면 ready 그대로

4. **`schema-streaming-prev.test.ts`**
   - HostGenerationSchema.streaming이 prevSelected 받음
   - v8 → v9 migration: prev 없는 streaming → prev=null 추가
   - onRehydrateStorage scrub은 그대로 streaming → idle

기존 테스트:
- `useHostGeneration` 관련 — store 액션 mock으로 갱신
- `use-host-stream.test.tsx` — 영향 없음 (worker가 직접 streamHost 호출, TQ mutation surface는 별도 유지)

---

## 9. 구현 순서 (제안 commit 분할)

각 commit 독립적으로 green, bisectable.

1. `chore(schema): allow prevSelected on streaming state` (schema + persist v8→v9)
2. `feat(stores): add streamWorkers module + tests` (host + composite)
3. `feat(stores): wizardStore actions for start/abort generation`
4. `refactor(hooks): useHostGeneration → store selector` (+ composite)
5. `fix(step1): preserve prev tile during streaming (gate change)` (+ Step 2)
6. `test: streaming-prev-preservation regression` (Bug A)
7. `test: step-navigation-resume regression` (Bug B)

---

## 10. Risk & rollback

| Risk | 대응 |
|---|---|
| Module-level worker가 dev HMR에서 leak | `import.meta.hot.dispose()` cleanup; dev 30분 dogfood |
| StrictMode double-mount → double-fire | start action이 idempotent하게 abort prior |
| v8 → v9 migration 실패 | onRehydrateStorage가 streaming scrub → 마이그레이션 실패해도 idle로 떨어져 사용자 영향 거의 없음. 그래도 handcrafted v8 blob test 포함 |
| 기존 useHostGeneration consumer가 hook 내부 state 의존 | 전부 selector로 대체되므로 surface 동일 (regenerate, abort, isLoading 등) |
| sign-out 시 worker가 살아남음 | sign-out flow에서 `abortHostStream()` + `abortCompositeStream()` 명시 호출 |
| Telemetry 누락 | 향후 enhancement — stream start/abort/fail에 structured log |

**Rollback:** 7개 commit revert as a block. schema 다운그레이드 불필요 (extra field on streaming은 backward-compat).

---

## 11. 본 PR 범위 외 (future)

- **Step 3 (음성/영상) resume 동일 패턴 적용** — 다른 lifecycle (TTS, render) 라 별도 검토.
- **Backend resubscribe endpoint** (`/api/host/generate/{batch_id}/stream`) — 새로고침 후도 살리고 싶을 때.
- **TopBar 작업 panel에 step별 진행 상태 표시** — Persistent indicator 강화.
- **알림 (toast) when 다른 step에 있을 때 done** — "쇼호스트 후보 4장 준비됐어요" 클릭 시 Step 1 복귀.
- **History view** — 모든 batch를 시간순으로 + thumbnail. Sora-style library.

---

## 12. /plan-design-review · /plan-eng-review 질문지

### Design 측
1. Mid-stream에 Step 이동 시 TopBar pill 외에 추가 indicator 필요한가? (per-step empty state에 "Step 1 진행 중" 미니 카드?)
2. done이 백그라운드에서 떨어졌을 때 toast/뱃지/소리 — 사용자 방해가 적당한 수준?
3. Bug A의 prev tile 강조 — 그냥 dashed border 유지 vs 더 명시적 라벨?

### Eng 측
1. Module-level worker singleton vs `WizardProvider` React context — 둘 중 선호?
2. Schema persist version bump 정책 — v9가 적절한 단계인가?
3. Worker 코드의 위치 — `stores/streamWorkers.ts` vs `wizard/lifecycle/streams.ts` vs 다른 곳?
4. Backend /stream에서 client disconnect 시 saved partial files orphan 문제 — 본 PR 범위 외로 두는가?
5. TanStack Query mutation surface (`useHostStream`) — 유지·deprecate·통합?
