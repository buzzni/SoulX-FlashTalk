<!-- /autoplan restore point: /opt/home/jack/.gstack/projects/buzzni-SoulX-FlashTalk/feat-streaming-resume-autoplan-restore-20260427-230008.md -->
# Streaming Resume — `GenerationJob`을 first-class 엔티티로

**Branch:** `feat/streaming-resume`
**Author:** jack-buzzni (with Claude)
**Date:** 2026-04-27
**Status:** v2 (Reframed after autoplan Phase 1 dual voice — option B)

---

## 0. 문제와 사용자 의도

Step 1·2에서 두 회귀:
- **A.** 다시 만들기 시 5번째 "이전 선택" 타일이 잠깐 사라짐
- **B.** 생성 중 다음 step 갔다 오면 stream 끊김 + prev 사라짐

사용자 의도:
> 당연히 다른 단계 갔다와도 생성 중이어야 하지

> 그냥 완벽하게 두세번 작업할 필요가 없으면 돼

**autoplan Phase 1 dual voice (Codex + 독립 Claude subagent) 만장일치 결론:**
이 두 버그는 *증상*이고, 진짜 원인은 **generation이 product에서 first-class 엔티티가 아니라는 것**. UI state로 다루는 한 lifecycle 갭은 계속 새로 발견된다. Bug A는 schema 결함, Bug B는 component-bound lifecycle 결함. 같은 frame의 두 얼굴.

따라서 v2 plan은 **server-side `GenerationJob` entity** 도입을 본 PR 범위로 끌어옴. frontend는 thin renderer가 되고 lifecycle은 backend가 owner.

---

## 1. UX Vision — 사용자 mental model (변경 없음)

> "내 생성 작업은 어딘가에서 살아 있다. 어디로 이동하든 따라오고, 끝나면 알려주고, 결과는 어디서든 다시 꺼내 볼 수 있다."

v1과 동일. 차이는 implementation이 이 vision을 진짜로 지원하는가.

### 패턴 reference (변경 없음)
- **Midjourney/Sora/Runway/ChatGPT** — 모두 generation을 *durable asset*로 다룸. 우리는 표면 패턴 흉내내지 말고 본질을 가져온다.

### 우리 wizard에 대입
| 사용자가 한 것 | 보여줘야 할 것 |
|---|---|
| 생성 시작 | placeholder 4개 즉시(낙관적) + prev 5번째 그대로 + Job 카드 라이브러리에 즉시 |
| 다른 step 이동 | TopBar pill에 빨간 dot, panel에 "Job XXX 진행 중 · 60%" |
| step 복귀 | server에서 같은 Job state 받아 live UI 그대로 |
| 새로고침 | server에서 Job state 다시 받아 streaming or ready 그대로 |
| 다른 device 접속 | server에서 Job 받아 동일 진행도 |
| 페이지 닫음 | Job은 server에 그대로 살아 있음, 다음 접속 시 history |

---

## 2. 시나리오별 동작 (변경 없음 — 모두 server-owned이므로 자동 충족)

| 시나리오 | UX | 어떻게 가능한가 |
|---|---|---|
| Cold start | placeholder 4개 즉시 + Job 카드 | client `POST /api/jobs` → server가 batchId 즉시 반환 → SSE 연결 |
| Re-roll (prev 유지) | placeholder 4 + prev 5번째 | Job 새로 생성, prev는 wizard slice의 last selected에서 |
| Step round-trip | TopBar pill 빨간 dot 유지, 복귀 시 live | client는 SSE 끊고 step 이동, server는 Job 계속 진행. 복귀 시 `GET /api/jobs/:id` + SSE resubscribe |
| Reload mid-stream | streaming 그대로 이어 받음 | Persisted Job id를 wizard store에 저장. reload 후 SSE resubscribe로 events 이어 받음 |
| Race (더블클릭) | 1st cancel, 2nd start | client가 1st Job `DELETE /api/jobs/:id` 후 새 POST |
| Network drop | failed 상태, 재시도 가능 | server Job state=failed로 영속, 사용자 retry 버튼 |
| Cross-device | Job state 동일 | server-owned이므로 auth된 사용자는 모든 device에서 동일 |

---

## 3. Architecture — Server-Owned Job Lifecycle

```
┌─────────────────────────────────────────────────────────┐
│  Backend                                                 │
│                                                          │
│  ┌─ DB ─────────────────────────────┐                   │
│  │ generation_jobs                  │                   │
│  │  id (uuid)                       │                   │
│  │  user_id                         │                   │
│  │  kind: 'host' | 'composite'      │                   │
│  │  state: pending|streaming|ready|failed|cancelled│    │
│  │  input_hash (dedupe key)         │                   │
│  │  input_blob (denormalized)       │                   │
│  │  prev_selected_image_id          │                   │
│  │  variants (jsonb array)          │                   │
│  │  created_at, updated_at          │                   │
│  └──────────────────────────────────┘                   │
│                                                          │
│  ┌─ Background worker (asyncio task) ───────────────┐   │
│  │ - row 추가 시 trigger                             │   │
│  │ - stream_*_candidates() 소비                      │   │
│  │ - 각 evt마다 row update + event log append        │   │
│  │ - done/fatal 시 final state 기록                  │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌─ REST ──────────────────────────────────┐            │
│  │ POST   /api/jobs              create + enqueue       │
│  │ GET    /api/jobs/:id          current state          │
│  │ GET    /api/jobs/:id/events   SSE (resubscribable)   │
│  │ DELETE /api/jobs/:id          cancel                 │
│  │ GET    /api/jobs?kind=host    list (history)         │
│  └────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────┘
                           ▲
                           │ HTTP + SSE (auth via JWT)
                           │
┌─────────────────────────────────────────────────────────┐
│  Frontend (thin renderer)                                │
│                                                          │
│  wizardStore.host.activeJobId / composite.activeJobId    │
│   (persisted — 새로고침 후 resubscribe key)               │
│                                                          │
│  hostJobSubscription (module-level, 1 active SSE)        │
│   - reads activeJobId from store                         │
│   - GET /api/jobs/:id (snapshot) + SSE resubscribe       │
│   - writes events to wizardStore.host.generation         │
│   - HMR-safe cleanup                                     │
│                                                          │
│  Components:                                             │
│   - Step1Host: useStore(s => s.host.generation) + dispatch│
│   - TopBar pill: useStore — 진행 중 Job 있으면 빨간 dot  │
│   - HistoryView (future): GET /api/jobs?kind=host        │
└─────────────────────────────────────────────────────────┘
```

**핵심 변경:**
- batch_id (frontend transient) → job_id (server persisted UUID)
- generation 시작 = client가 `POST /api/jobs`로 row 생성, server가 background worker에서 stream 진행. 이 시점부터 client SSE 끊겨도 server는 계속.
- step navigation, reload, cross-device — 모두 `GET /api/jobs/:id` + SSE resubscribe로 이어 받음

---

## 4. Backend 변경

### 4.1 DB schema (`modules/repositories/generation_jobs.py` 신규)
```python
class GenerationJob(BaseModel):
    id: UUID
    user_id: str
    kind: Literal['host', 'composite']
    state: Literal['pending', 'streaming', 'ready', 'failed', 'cancelled']
    input_hash: str       # dedupe + cache key
    input_blob: dict      # denormalized request body
    prev_selected_image_id: Optional[str]
    variants: list[VariantRecord]   # jsonb
    error: Optional[str]
    created_at: datetime
    updated_at: datetime
```

migration: studio_007 (sqlite/postgres + mongodb 둘 다 — repositories 패턴 그대로).

### 4.2 Background worker
```python
# modules/job_runner.py (신규)
async def run_host_job(job_id: UUID):
    job = await jobs.get(job_id)
    saved_paths = []
    async for evt in stream_host_candidates(**job.input_blob):
        if evt['type'] == 'candidate':
            await jobs.append_variant(job_id, lift(evt))
            saved_paths.append(evt['path'])
        elif evt['type'] == 'done':
            await jobs.mark_ready(job_id, batch_id=...)
        elif evt['type'] == 'fatal':
            await jobs.mark_failed(job_id, error=evt['error'])
        await events_pubsub.publish(job_id, evt)  # SSE resubscriber에게 전파
```

`asyncio.create_task`로 spawn, request lifecycle과 분리. 기존 `host_repo.record_batch` 등 lifecycle bookkeeping는 `mark_ready`로 통합.

### 4.3 SSE resubscribe (`/api/jobs/:id/events`)
- 클라이언트 연결 시 server는 (a) Job snapshot 즉시 emit, (b) events_pubsub에 subscribe해 이후 evt 전파.
- 클라이언트 끊겨도 worker는 계속, pubsub만 끊김.
- 클라이언트 다시 연결하면 (a) 갱신된 snapshot + (b) 이후 evt.

events_pubsub는 in-process asyncio.Queue per job_id (단일 worker process 가정. multi-worker 확장은 v2.1 future — Redis pub/sub).

### 4.4 기존 endpoint 폐기
- `/api/host/generate` (sync) → 유지 (단일 candidate 미리보기 등에 사용)
- `/api/host/generate/stream` (1-shot SSE) → **deprecated**, jobs로 마이그레이션
- `/api/composite/generate{,/stream}` 동일 처리

### 4.5 Backend 작업량
- 신규 파일: `modules/repositories/generation_jobs.py`, `modules/job_runner.py`, `modules/events_pubsub.py`
- migration 1개 (studio_007)
- `app.py`에 `/api/jobs/*` 4 endpoint
- 기존 stream endpoint deprecation
- tests: jobs CRUD, runner happy/error, pubsub multi-subscriber

대략 1.5–2주.

---

## 5. Frontend 변경

### 5.1 Schema (`frontend/src/wizard/schema.ts`)
```ts
// Host slice — generation은 activeJobId만 보유
HostGenerationSchema = discriminatedUnion('state', [
  z.object({ state: z.literal('idle') }),
  z.object({ state: z.literal('attached'), jobId: z.string() }),
  // 'attached' 면 frontend는 jobId로 server에서 풀 + SSE.
  // streaming/ready/failed는 server에서만 의미가 있고, UI는 server snapshot에서 derive.
]);

// Cache (snapshot of current job, 비persisted)
JobSnapshotSchema = z.object({
  id: z.string(),
  state: z.enum(['streaming', 'ready', 'failed', 'cancelled']),
  variants: z.array(...),
  prevSelectedImageId: z.string().nullable(),
  error: z.string().nullable(),
  ...
});
```

### 5.2 Subscription 모듈 (`frontend/src/stores/jobSubscription.ts`)
```ts
// host slice 1개, composite slice 1개 active SSE.
let hostSubscription: { jobId: string; abort: () => void } | null = null;

export function subscribeToHostJob(jobId: string) {
  hostSubscription?.abort();
  const ctrl = new AbortController();
  hostSubscription = { jobId, abort: () => ctrl.abort() };

  // 1) snapshot
  fetch(`/api/jobs/${jobId}`, { signal: ctrl.signal })
    .then(r => r.json())
    .then(snap => useJobCacheStore.getState().setHostSnapshot(snap));

  // 2) SSE
  (async () => {
    for await (const evt of streamJobEvents(jobId, ctrl.signal)) {
      useJobCacheStore.getState().applyHostEvent(evt);
    }
  })();
}

export function unsubscribeHostJob() {
  hostSubscription?.abort();
  hostSubscription = null;
}
```

`activeJobId` 가 wizardStore에 set되면 자동으로 subscribe. wizardStore의 `activeJobId`는 persist 됨 → reload 후도 자동 resubscribe.

### 5.3 Component
```tsx
// Step1Host.tsx
function Step1Host() {
  const jobId = useWizardStore(s => 
    s.host.generation.state === 'attached' ? s.host.generation.jobId : null
  );
  const snap = useJobCacheStore(s => jobId ? s.hostSnapshots[jobId] : null);
  const variants = snap?.variants ?? [];
  const prevSelected = snap?.prevSelectedImageId ? lookupPrev(snap) : null;
  const isLoading = snap?.state === 'streaming';

  // ... renders identical to today's UI
}

// dispatch
async function regenerate(input) {
  const r = await fetch('/api/jobs', { method: 'POST', body: ... });
  const { id } = await r.json();
  useWizardStore.getState().setHost(s => ({ ...s, generation: { state: 'attached', jobId: id }}));
  // subscribeToHostJob(id) 자동 호출 (store subscription)
}
```

### 5.4 UI gate (Bug A 직접 해결)
```diff
- {variants.length > 0 && (
+ {(variants.length > 0 || prevSelected) && (
```

### 5.5 Frontend 작업량
- 신규 파일: `stores/jobSubscription.ts`, `stores/jobCacheStore.ts`, `api/jobs.ts`
- schema 변경 (HostGeneration·CompositionGeneration discriminator 단순화)
- migration v8→v9 (variants/prevSelected를 store 안에서 → activeJobId 만)
- `useHostGeneration` `useCompositeGeneration` → store selector
- Step1Host/Step2Composite 약간 수정
- TopBar pill — activeJobId 있으면 빨간 dot
- tests

대략 1주.

### 5.6 본 PR 범위 외 (v2.1 future)
- HistoryView (`GET /api/jobs?kind=host` + grid)
- Cross-device toast notification
- Step 3 동일 패턴 적용
- Multi-worker scale (Redis pub/sub)

---

## 6. UI 가드 변경 (Bug A)
`Step1Host.tsx:287` (composite 동형):
```diff
- {variants.length > 0 && (
+ {(variants.length > 0 || prevSelected) && (
```

---

## 7. 시나리오별 동작 검증 (server-owned)

| 시나리오 | 동작 |
|---|---|
| cold start | POST → jobId 즉시 → activeJobId set → SSE 연결 → placeholder 4개 |
| re-roll | new POST (옛 SSE는 unsubscribe, 옛 Job은 server에서 cancelled로 mark) → 새 jobId → prev=last selected |
| step round-trip | unsubscribe SSE on Step1 unmount, server worker 계속. 복귀 시 `activeJobId`로 GET + resubscribe → 그동안의 events 다 받아옴 |
| reload | persisted activeJobId → mount 후 자동 resubscribe → snapshot + future events |
| cross-device | 동일 user, 동일 activeJobId → server에서 동일 상태 |
| race (더블클릭) | 1st DELETE + 2nd POST. 1st는 server에서 cancelled |
| failed | server worker mark failed, snapshot.state=failed → UI error |
| sign-out | activeJobId clear, SSE abort (server worker는 계속, 다음 로그인 시 history에서 retrieve) |

---

## 8. Test 커버리지

### Backend
- `test_jobs_repo.py` — CRUD + state transitions
- `test_job_runner.py` — happy path, fatal, cancel mid-stream
- `test_events_pubsub.py` — multi-subscriber, late join (snapshot+events)
- `test_jobs_api.py` — POST/GET/DELETE, auth, ownership

### Frontend
- `jobSubscription.test.ts` — subscribe/unsubscribe, reconnect on activeJobId change
- `step-navigation-resume.test.tsx` — Bug B 회귀
- `streaming-prev-preservation.test.tsx` — Bug A 회귀
- `reload-survive.test.tsx` — persist activeJobId, mount → snapshot fetch → events
- `cross-tab-share.test.tsx` (옵션) — BroadcastChannel로 multi-tab 알림 (v2.1)

### E2E
- Cypress: Step 1 시작 → Step 2 이동 → Step 1 복귀 → 결과 그대로
- Cypress: Step 1 시작 → reload → 결과 그대로

---

## 9. 구현 순서 (commit 분할)

### Phase A — Backend (1.5-2주)
1. `feat(db): generation_jobs table + repository` (migration studio_007)
2. `feat(api): POST /api/jobs (host + composite)`
3. `feat(worker): job_runner background task`
4. `feat(api): GET /api/jobs/:id snapshot endpoint`
5. `feat(events): asyncio pubsub + GET /api/jobs/:id/events SSE`
6. `feat(api): DELETE /api/jobs/:id cancellation`
7. `chore(api): deprecate /api/host/generate/stream + composite/generate/stream`

### Phase B — Frontend (1주)
8. `chore(schema): HostGeneration discriminator → idle | attached(jobId)` (v9)
9. `feat(stores): jobCacheStore + jobSubscription module`
10. `feat(api): client functions for /api/jobs/*`
11. `refactor(hooks): useHostGeneration → store selector`
12. `refactor(hooks): useCompositeGeneration → store selector`
13. `fix(step1): preserve prev tile during streaming`
14. `feat(topbar): pill 빨간 dot when activeJobId present`
15. `test: bug-A regression + bug-B regression`

### Phase C — Migration & cutover (3일)
16. Frontend dual-mode (구 endpoint + 신 endpoint 동시 지원)
17. 모든 사용자 신 endpoint로 cutover
18. 구 endpoint 코드 제거

총 ~3-4주. 1.5-2주는 backend 의존이라 frontend 진행과 병렬 가능 (Phase A·B 동시 시작).

---

## 10. Risk & rollback

| Risk | 대응 |
|---|---|
| backend worker 다중 process scale | 본 PR은 single-process 가정. v2.1에서 Redis pub/sub로 확장 |
| job 누적으로 DB 부풀음 | TTL job: state=ready/failed/cancelled 인 job은 7일 후 archive |
| orphan saved files (cancel 후 candidate file) | runner에서 cancel 시 cleanup (단순 파일 삭제) |
| Migration v8→v9 시 in-flight stream | 기존 사용자는 다음 로그인 시 strip. activeJobId=null 로 시작 |
| backend 변경이 frontend ship보다 느림 | Phase A 먼저, Phase B는 기존 endpoint와 dual-mode 지원하다가 cutover |

**Rollback:** Phase A·B를 별도 revert 가능. cutover 전이라면 frontend는 신·구 endpoint 둘 다 지원하므로 backend rollback해도 frontend 동작.

---

## 11. v1 plan과 비교 (왜 reframe했는가)

| 측면 | v1 (frontend-only + localStorage) | v2 (server-owned Job) |
|---|---|---|
| Bug A·B 해결 | yes | yes |
| reload survive | partial result hack (ghost data) | server snapshot 정확 |
| cross-device | 불가 | 자동 |
| history | future PR | future PR이지만 인프라 준비 |
| Step 3 확장 | 별도 lifecycle 작업 필요 | jobs 인프라 재사용 |
| 작업량 | ~1주 (frontend) | ~3-4주 (backend + frontend) |
| 6개월 후 처분 risk | 高 (cross-device 시대 도래 시 폐기) | 低 (asset pipeline 표준) |

v1은 정직하지 못한 vision-impl mismatch. v2는 스타팅 cost는 더 크지만 mental model과 일치.

---

## 12. Phase 1 dual voice 결정 기록 (autoplan)

### Codex SAYS — strategy challenge (요약)
- generation을 first-class server entity로 만들지 않으면 vision-impl 모순
- localStorage partial persist는 ghost data 위험
- v1 plan §1, §4, §7, §8이 reload 정책에서 internal contradiction
- Recommendation: contract OR reframe — 둘 중 하나

### Claude Subagent SAYS — independent (요약)
- Bug 두 개를 인프라급 야망으로 격상
- Step 분리 자체가 진짜 문제일 가능성 (single canvas reframe)
- Module singleton은 N-parallel 미래에 무너짐
- 6개월 후 cross-device 시대에 v1 인프라 처분 대상

### Consensus: 6/6 dimensions NO 또는 PARTIAL → strong cross-model alignment that v1 needed reframe.

### User Challenge resolution: 옵션 B (Reframe) 선택. v2 본 문서.

---

## 13. Phase 2 (Design) 진입 — 다음 turn

v2 plan 기반으로 design review 진행:
- UX flow는 §2와 동일하지만 implementation이 server-owned이라 wireframe 일부 추가 검토:
  - Job 카드 (라이브러리 view, 본 PR 범위 외이지만 future ready)
  - TopBar pill panel — activeJobId 있을 때 panel에 진행 표시
  - reload 시 snapshot fetch loading 단계 (1-2초 spinner)
  - cross-device 진입 시 "다른 기기에서 시작한 작업" 안내
- 새 wireframe 검토 후 codex design + claude subagent design dual voice
