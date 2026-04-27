# Streaming Resume — Eng Spec

**Branch:** `feat/streaming-resume`
**Companion to:** `streaming-resume-plan.md` (v2) + `streaming-resume-design-spec.md`
**Date:** 2026-04-27
**Status:** Eng spec phase (autoplan Phase 3 가 요구한 14 high/critical issue 해소)

이 문서는 plan v2의 eng 측 미세화. plan은 무엇을 만들지, 이 문서는 어떻게 안전하게 만들지.

---

## 1. CRITICAL — Migration 번호 정정

`scripts/studio_007_local_import.py` 가 이미 존재. v2 plan의 `studio_007` 사용 불가.

**결정:** v2의 모든 `studio_007` 참조 → `studio_008`로 rename.

영향 받는 항목:
- migration 파일명: `studio_008_generation_jobs.py`
- DB upgrade 함수 안 version 인자
- `/docs/plans/streaming-resume-plan.md` §4.1, §9 step 1
- 후속 PR 명명 (studio_009, studio_010 ...)

---

## 2. Worker lifecycle (high — 4 voices 만장일치)

### 2.1 핵심 결함
- `asyncio.create_task` 강참조 손실 → 작업 중 GC
- Worker crash mid-stream → DB stuck in `streaming` 영구
- Graceful shutdown → in-flight cleanup 없음
- multi-worker 시 POST/SSE/cancel 다른 worker로 분산

### 2.2 JobRunner 클래스 (신규 `modules/job_runner.py`)
참조 패턴: `modules/task_queue.py`의 `TaskQueue`.

```python
class JobRunner:
    """
    Single-process gen-job orchestrator.
    Mirrors task_queue.TaskQueue ownership patterns.
    """
    def __init__(self):
        self._running: dict[UUID, asyncio.Task] = {}   # 강참조 보유
        self._stopping = False
        self._heartbeat_task: asyncio.Task | None = None

    async def start(self):
        # 1) startup recovery: 'streaming' or 'pending' jobs
        await self._recover_interrupted()
        # 2) heartbeat sweep
        self._heartbeat_task = asyncio.create_task(self._sweep_stale())

    async def stop(self):
        self._stopping = True
        # in-flight 작업 취소 (DB 닫기 전)
        for job_id, task in list(self._running.items()):
            task.cancel()
            try: await task
            except (asyncio.CancelledError, Exception): pass
            await jobs_repo.mark_failed(job_id, error="server restart")
        if self._heartbeat_task:
            self._heartbeat_task.cancel()

    async def submit(self, job_id: UUID):
        if job_id in self._running:
            return  # idempotent
        task = asyncio.create_task(self._run_one(job_id))
        self._running[job_id] = task
        task.add_done_callback(lambda _: self._running.pop(job_id, None))

    async def _run_one(self, job_id: UUID):
        job = await jobs_repo.get(job_id)
        try:
            async for evt in stream_for_kind(job.kind, job.input_blob):
                # cancellation 체크 (협조적)
                if await jobs_repo.is_cancelled(job_id):
                    break
                if evt['type'] == 'candidate':
                    ok = await jobs_repo.append_variant_if_streaming(
                        job_id, lift(evt))
                    if not ok:
                        # state already terminal (cancelled/failed)
                        break
                elif evt['type'] == 'done':
                    await jobs_repo.mark_ready_with_lifecycle(
                        job_id, batch_id=str(job_id))
                elif evt['type'] == 'fatal':
                    await jobs_repo.mark_failed(
                        job_id, error=evt['error'])
                await jobs_pubsub.publish(job_id, evt)
        except asyncio.CancelledError:
            await jobs_repo.mark_failed(
                job_id, error="cancelled by server")
            raise

    async def _recover_interrupted(self):
        """At startup: stale 'streaming' / 'pending' → 'failed'."""
        stale = await jobs_repo.list_stale(
            states=['streaming', 'pending'])
        for j in stale:
            await jobs_repo.mark_failed(
                j.id, error="server restarted before completion")
        if stale:
            logger.info(
                "Recovered %d stale generation jobs at startup", len(stale))

    async def _sweep_stale(self):
        """Periodic: heartbeat_at < now-5min and state='streaming' → 'failed'.
        Single-process에서는 사실상 불필요하지만 multi-process 대비 + 
        작업 중 disk full 같은 silent stall 보호."""
        while not self._stopping:
            try:
                await asyncio.sleep(60)
                stale = await jobs_repo.list_heartbeat_stale(
                    older_than=timedelta(minutes=5))
                for j in stale:
                    await jobs_repo.mark_failed(
                        j.id, error="worker timeout (no heartbeat)")
            except Exception:
                logger.exception("heartbeat sweep error (non-fatal)")
```

### 2.3 app.py 통합
```python
# app.py startup
@app.on_event("startup")
async def startup_event():
    # ... 기존 ...
    job_runner = JobRunner()
    await job_runner.start()
    app.state.job_runner = job_runner

@app.on_event("shutdown")
async def shutdown_event():
    runner: JobRunner = app.state.job_runner
    await runner.stop()                # in-flight 취소 먼저
    # ... 기존 DB close 등 ...
```

### 2.4 Multi-worker fail-fast
`start_backend.sh:11`의 `python app.py --port 8001`은 single-process. 다른 worker로 늘리면 즉시 실패해야.

```python
# app.py 안 startup 직전
if int(os.environ.get("WEB_CONCURRENCY", "1")) > 1:
    raise RuntimeError(
        "GenerationJobs requires single-process. "
        "Set WEB_CONCURRENCY=1 or migrate to v2.1 (Redis pubsub).")
```

`start_backend.sh`에도 주석:
```bash
# WARNING: WEB_CONCURRENCY=1 required for generation_jobs.
# Multi-worker breaks SSE pubsub (in-process asyncio.Queue).
# v2.1 will introduce Redis-backed pubsub for multi-worker.
```

---

## 3. SSE handshake (high — 4 voices 만장일치)

### 3.1 race 문제
naive 구현:
```
T0: client GET /api/jobs/:id            → snapshot v=2
T1: worker emits candidate v=3          → no subscribers, lost
T2: client subscribes /events
T3: worker emits candidate v=4          → client gets v=4
```
v=3 영영 손실.

### 3.2 해결: subscribe-first + per-job seq
```python
@app.get("/api/jobs/{job_id}/events")
async def jobs_events(
    job_id: UUID,
    request: Request,
):
    user = auth_module.get_request_user(request)
    job = await jobs_repo.get(job_id)
    if job.user_id != user["user_id"]:
        raise HTTPException(404)
    
    async def gen():
        last_event_id = request.headers.get("Last-Event-ID")
        after_seq = int(last_event_id) if last_event_id else 0
        
        # 1) subscribe FIRST (buffer events into local queue)
        async with jobs_pubsub.subscribe(job_id) as buffer:
            # 2) snapshot read with current seq
            snap = await jobs_repo.snapshot_with_seq(job_id)
            # 3) emit snapshot if needed
            if after_seq < snap.seq:
                yield sse_format(
                    "snapshot", json.dumps(snap.dict()), id=snap.seq)
            
            # 4) drain buffered events with seq > snap.seq
            async for evt in buffer:
                if evt.seq > max(after_seq, snap.seq):
                    yield sse_format(
                        evt.type, json.dumps(evt.payload), id=evt.seq)
                if evt.type in ('done', 'fatal', 'cancelled'):
                    break
    
    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
```

`sse_format` 헬퍼:
```python
def sse_format(event: str, data: str, id: int | None = None) -> str:
    parts = []
    if id is not None:
        parts.append(f"id: {id}")
    parts.append(f"event: {event}")
    parts.append(f"data: {data}")
    return "\n".join(parts) + "\n\n"
```

### 3.3 jobs_pubsub
```python
# modules/jobs_pubsub.py
class JobsPubSub:
    def __init__(self):
        self._subs: dict[UUID, list[asyncio.Queue]] = defaultdict(list)
        self._seqs: dict[UUID, int] = defaultdict(int)
    
    @asynccontextmanager
    async def subscribe(self, job_id: UUID):
        q: asyncio.Queue = asyncio.Queue(maxsize=1024)
        self._subs[job_id].append(q)
        try:
            yield self._stream(q)
        finally:
            self._subs[job_id].remove(q)
            if not self._subs[job_id]:
                del self._subs[job_id]
    
    async def _stream(self, q: asyncio.Queue):
        while True:
            evt = await q.get()
            yield evt
    
    async def publish(self, job_id: UUID, evt_payload: dict):
        self._seqs[job_id] += 1
        evt = JobEvent(
            seq=self._seqs[job_id],
            type=evt_payload['type'],
            payload=evt_payload,
        )
        for q in self._subs.get(job_id, []):
            try: q.put_nowait(evt)
            except asyncio.QueueFull:
                logger.warning(
                    "subscriber queue full for job %s; dropping", job_id)
```

`seq`는 in-memory (`self._seqs`). pubsub이 dies/restart하면 seq 재시작 — 그 사이 cliendt-side `Last-Event-ID`는 의미 잃음 (full snapshot 다시 받음).

### 3.4 클라이언트 reconnect (frontend)
```ts
// jobSubscription.ts
async function* streamJobEvents(jobId: string, signal: AbortSignal) {
  let lastEventId: string | null = null;
  while (!signal.aborted) {
    try {
      const r = await fetch(`/api/jobs/${jobId}/events`, {
        signal,
        headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {},
      });
      // SSE parsing loop ...
      for await (const evt of parseSSE(r.body!)) {
        if (evt.id) lastEventId = evt.id;
        yield evt;
        if (evt.type === 'done' || evt.type === 'fatal') return;
      }
    } catch (e) {
      if (signal.aborted) return;
      // network drop → exponential backoff retry
      await sleep(jitter(1000, 5000));
    }
  }
}
```

---

## 4. Cancel-vs-append atomicity (high)

### 4.1 문제
worker가 `append_variant` 호출 직전, 사용자가 `DELETE` → state=`cancelled`. worker는 모르고 append 실행 → cancelled job에 variant 추가 + saved_path 누적.

### 4.2 해결: conditional update
```python
# jobs_repo.py
async def append_variant_if_streaming(
    job_id: UUID, variant: VariantRecord,
) -> bool:
    """Returns True if appended, False if state was no longer streaming."""
    # PostgreSQL
    result = await db.execute(
        "UPDATE generation_jobs "
        "SET variants = variants || %s::jsonb, updated_at = NOW(), heartbeat_at = NOW() "
        "WHERE id = %s AND state = 'streaming' "
        "RETURNING id",
        [json.dumps([variant]), job_id])
    return result.rowcount > 0
    
    # Mongo equivalent
    res = await coll.update_one(
        {"_id": job_id, "state": "streaming"},
        {"$push": {"variants": variant},
         "$set": {"updated_at": now, "heartbeat_at": now}},
    )
    return res.matched_count > 0
```

worker:
```python
ok = await jobs_repo.append_variant_if_streaming(job_id, evt_lifted)
if not ok:
    # cancelled or terminal
    # cleanup: delete the file we just saved (it won't be recorded)
    if 'path' in evt_lifted:
        try: os.unlink(evt_lifted['path'])
        except OSError: pass
    break
```

### 4.3 mark_ready 동일 패턴
```python
async def mark_ready_with_lifecycle(
    job_id: UUID, batch_id: str,
) -> bool:
    """전이 streaming → ready. + 기존 host_repo lifecycle bookkeeping."""
    job = await jobs_repo.get(job_id)
    if job.state != 'streaming':
        return False
    
    saved_paths = [v['path'] for v in job.variants if 'path' in v]
    
    # 기존 host_repo 호출과 1:1 매핑 (record_batch BEFORE cleanup):
    if job.kind == 'host':
        await host_repo.record_batch(
            job.user_id, "1-host", saved_paths, batch_id)
        await host_repo.cleanup_after_generate(
            job.user_id, "1-host", batch_id)
        state = await host_repo.get_state(job.user_id, "1-host")
        prev_image_id = state.get("prev_selected", {}).get("image_id")
    elif job.kind == 'composite':
        await host_repo.record_batch(
            job.user_id, "2-composite", saved_paths, batch_id)
        await host_repo.cleanup_after_generate(
            job.user_id, "2-composite", batch_id)
        state = await host_repo.get_state(job.user_id, "2-composite")
        prev_image_id = state.get("prev_selected", {}).get("image_id")
    
    # atomic 전이
    res = await coll.update_one(
        {"_id": job_id, "state": "streaming"},
        {"$set": {
            "state": "ready",
            "batch_id": batch_id,
            "prev_selected_image_id": prev_image_id,
            "updated_at": now,
        }},
    )
    return res.matched_count > 0
```

### 4.4 cancel 동일 패턴
```python
async def cancel_if_active(job_id: UUID, reason: str) -> bool:
    res = await coll.update_one(
        {"_id": job_id, "state": {"$in": ["pending", "streaming"]}},
        {"$set": {"state": "cancelled", "error": reason, "updated_at": now}},
    )
    return res.matched_count > 0
```

`is_cancelled(job_id)`는 매 candidate evt 사이에 협조적 체크.

---

## 5. mark_ready state diagram (lifecycle 보존)

기존 `app.py:2418-2422`의 4-step 시퀀스를 v2에서 1:1 보존.

```
┌──────────────────────────────────────────┐
│ Worker receives evt['type'] == 'done'   │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│ jobs_repo.mark_ready_with_lifecycle()   │
│                                          │
│  1) Read job by id (assert streaming)   │
│  2) Compute saved_paths from variants    │
│  3) host_repo.record_batch(             │
│       user_id, kind, paths, batch_id)   │  ← 기존 동작 유지
│  4) host_repo.cleanup_after_generate(   │
│       user_id, kind, batch_id)          │  ← 기존 동작 유지
│  5) state = host_repo.get_state(...)    │
│     prev_id = state['prev_selected']    │
│  6) UPDATE generation_jobs SET          │
│       state='ready', batch_id=...,      │
│       prev_selected_image_id=prev_id    │
│     WHERE id=? AND state='streaming'    │
│     (atomic guard)                      │
│  7) jobs_pubsub.publish(job_id,         │
│     {type:'done', batch_id, prev_id})   │
└──────────────────────────────────────────┘
```

cancelled / failed 시 `record_batch` / `cleanup_after_generate`은 **호출 안 함**. 즉 cancelled 상태 job의 saved files는 candidates collection에 들어가지 않음. 이는 의도된 behavior change — cancelled = "사용자가 폐기"이고 partial을 prev로 carry하면 안 됨.

`record_batch`/`cleanup`이 실패하면? job state는 `streaming` 그대로 (atomic guard 실패) → heartbeat sweep이 5분 후 `failed`로 → 사용자 retry 가능.

---

## 6. 핵심 결정 5건

### 6.1 input_hash semantics — **dedupe-by-reuse**
중복 POST(같은 input_blob) 처리:
- POST 시 server가 `input_hash = sha256(canonical_json(input_blob))` 계산
- 기존 active job (`state IN ('pending','streaming')` AND `input_hash = ?` AND `user_id = ?`) 있으면 그 job_id 반환 (200 status, 새 row 안 만듦)
- ready/failed/cancelled job은 재사용 안 함 (사용자가 같은 input으로 재실행 원함)
- 동시 두 POST → DB unique partial index가 race 처리:
  ```sql
  CREATE UNIQUE INDEX idx_jobs_active_dedupe
    ON generation_jobs (user_id, input_hash)
    WHERE state IN ('pending', 'streaming');
  ```
- 1st INSERT 성공 → 새 job. 2nd INSERT는 DuplicateKeyError → SELECT로 retrieve, 같은 id 반환 (`studio_host_repo.py:250` 패턴 참조)

이렇게 하면 사용자가 더블클릭해도 server는 1개 job만 진행, frontend 양쪽 mutation은 같은 id 받음 → 같은 SSE에 합류.

### 6.2 batch_id ↔ job_id 관계 — **batch_id = str(job_id)**
- `batch_id`는 기존 `studio_host_repo.candidates` collection key. 이미 `batch_???` 형식이지만 `str(uuid)`도 호환 (string 비교).
- v2: `mark_ready` 시 `batch_id = str(job_id)` 사용 → candidates collection에는 uuid string으로 들어감
- 기존 v1 batch_id (e.g. `batch_3a4b9c`) 와 공존 가능 (별 prefix). 마이그레이션 backfill 불필요.
- frontend는 `batch_id`를 거의 안 봄 (lifecycle layer 안에서만 의미). prev_selected 추적은 image_id로.

### 6.3 useHostStream (TQ Lane F) — **delete in Phase B**
- `frontend/src/api/queries/use-host-stream.ts` 와 `use-host-stream.test.tsx` 삭제
- 프로덕션 consumer 0개 (test만)
- 새 path는 `jobSubscription.ts` + `jobCacheStore.ts`로 통합
- 기존 `useHostStream`이 의존하는 `streamHost`/`streamComposite` (api/host.ts, api/composite.ts) 함수도 deprecate (단, deprecation 마지막 단계에서)

### 6.4 Phase C cutover — **feature flag + 1주 soak**
- env var `STUDIO_USE_JOBS_API` (frontend) + `STUDIO_JOBS_ENABLED` (backend)
- Phase C step 16: 두 endpoint 모두 활성. frontend는 flag로 분기:
  ```ts
  const USE_JOBS = import.meta.env.VITE_USE_JOBS_API === 'true';
  if (USE_JOBS) await startJobBased(input);
  else await startStreamBased(input);
  ```
- Phase C step 17: 모든 사용자 flag=true (1주 soak, 모니터링)
- Phase C step 18: 구 endpoint 코드 + flag 분기 둘 다 제거
- Rollback: 1주 soak 중 flag=false로 즉시 복귀 가능

### 6.5 Composite runner — **host와 동형 dispatch**
```python
# job_runner.py
async def stream_for_kind(kind: str, input_blob: dict):
    if kind == 'host':
        from modules.host_generator import stream_host_candidates
        async for evt in stream_host_candidates(**input_blob):
            yield evt
    elif kind == 'composite':
        from modules.composite_generator import stream_composite
        async for evt in stream_composite(**input_blob):
            yield evt
    else:
        raise ValueError(f"unknown kind: {kind}")
```

`mark_ready_with_lifecycle` 안의 `host_repo.record_batch`/`cleanup_after_generate` 호출은 kind에 따라 step prefix만 다름 (`"1-host"` vs `"2-composite"`). 위 §4.3 코드 그대로.

---

## 7. DB schema 최종 (sqlite + mongodb 둘 다)

```sql
-- studio_008_generation_jobs.py (PostgreSQL or sqlite-equivalent)
CREATE TABLE generation_jobs (
    id              UUID PRIMARY KEY,
    user_id         VARCHAR(64) NOT NULL,
    kind            VARCHAR(16) NOT NULL CHECK (kind IN ('host','composite')),
    state           VARCHAR(16) NOT NULL CHECK (state IN
                       ('pending','streaming','ready','failed','cancelled')),
    input_hash      CHAR(64) NOT NULL,
    input_blob      JSONB NOT NULL,
    variants        JSONB NOT NULL DEFAULT '[]'::jsonb,
    prev_selected_image_id VARCHAR(255),
    batch_id        VARCHAR(64),
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    heartbeat_at    TIMESTAMPTZ
);

-- 인덱스
CREATE INDEX idx_jobs_user_kind_created
  ON generation_jobs (user_id, kind, created_at DESC);
CREATE INDEX idx_jobs_state_heartbeat
  ON generation_jobs (state, heartbeat_at)
  WHERE state = 'streaming';
CREATE INDEX idx_jobs_state_updated
  ON generation_jobs (state, updated_at)
  WHERE state IN ('ready','failed','cancelled');  -- TTL sweep
CREATE UNIQUE INDEX idx_jobs_active_dedupe
  ON generation_jobs (user_id, input_hash)
  WHERE state IN ('pending','streaming');
```

MongoDB: `generation_jobs` collection + 같은 인덱스(`createIndex` 명시). `kind`, `state`는 enum이지만 string으로.

### 크기 cap
- `variants` jsonb: hard cap 50 entries (현재 n=4 default, 안전 마진). worker가 cap 도달 시 `mark_failed` 호출.
- `input_blob`: POST 검증 시 JSON serialized 256KB cap. 초과 시 400.
- jsonb 안 image path는 server 내부 path 그대로 저장 (URL prefix는 응답 시점에 prepend).

### TTL 정책
- ready/failed/cancelled jobs: `updated_at < now - 7 days` → archive (별도 `generation_jobs_archive` table 또는 단순 delete + 파일 보존).
- 본 PR scope는 sweep 함수만 만들고 cron job은 v2.1.

### v8 → v9 migration table
| v8 host.generation | v9 host.generation | 설명 |
|---|---|---|
| `{state: 'idle'}` | `{state: 'idle'}` | 그대로 |
| `{state: 'streaming', ...}` | `{state: 'idle'}` | streaming은 frontend-only이던 이전이라 server에 jobs row 없음. drop. 사용자는 다시 만들기. |
| `{state: 'ready', variants, selected, prevSelected, ...}` | `{state: 'idle'}` | 이것도 drop. ready 결과는 candidates collection에 이미 보존되어 있음 (host_repo.record_batch). 사용자가 다시 step 1 진입 시 history view (v2.1)에서 retrieve. |
| `{state: 'failed', error}` | `{state: 'idle'}` | drop |

**즉 v8 → v9 마이그레이션은 모든 state를 `idle`로 reset.** 사용자 in-flight 작업 손실은 발생할 수 있지만, 마이그레이션은 deploy 한 번에 끝나는 일회성 사건이라 수용.

---

## 8. API endpoints (final)

```
POST   /api/jobs                     create + enqueue
  body: { kind: 'host'|'composite', input: { ... } }
  resp: { id, state, ... } (200; 같은 active hash면 기존 id 반환)
  errors: 400 (validation), 401, 413 (input too large)

GET    /api/jobs/:id                 snapshot
  resp: { id, kind, state, variants, prev_selected_image_id, batch_id, ... }
  errors: 401, 404 (not owner)

GET    /api/jobs/:id/events          SSE
  headers: Accept: text/event-stream, optional Last-Event-ID
  events: snapshot, candidate, done, failed, cancelled (with seq id)
  errors: 401, 404

DELETE /api/jobs/:id                 cancel
  resp: 204 (또는 200 with state)
  errors: 401, 404, 409 (already terminal)

GET    /api/jobs?kind=host&state=ready&limit=20&cursor=<job_id>
  cursor-based pagination, default limit 20 (max 50)
  resp: { items: [...], next_cursor: <job_id> | null }
  errors: 401
```

### 보안
- 모든 endpoint에 `auth_module.get_request_user(request)` 호출
- POST 시 `safe_upload_path` 호출로 input의 모든 path field 검증 (faceRefPath, outfitRefPath, styleRefPath, productPath 등). 검증된 절대 path만 `input_blob`에 저장.
- Worker에서도 `safe_upload_path` 재호출 (defense in depth — input_blob이 직접 DB에 inject됐을 가능성 보호).
- 모든 GET/DELETE/SSE에 `job.user_id == user.user_id` 체크. 불일치 시 404 (403 X — id 존재 leak 방지).
- 동시 SSE 연결 cap: per-user 10개. 초과 시 429.

---

## 9. Test 매트릭스 (최종 14개 + 기존 plan §8 보완)

### Backend
1. `test_jobs_repo.py` — CRUD, conditional updates (append, mark_ready, cancel)
2. `test_jobs_lifecycle_recovery.py` — startup recovery (stale streaming → failed)
3. `test_jobs_lifecycle_heartbeat.py` — heartbeat sweep (>5min stale → failed)
4. `test_job_runner_happy.py` — host/composite happy path
5. `test_job_runner_cancel_during_append.py` — DELETE during candidate write, no post-cancel writes
6. `test_job_runner_fatal.py` — fatal evt → state=failed
7. `test_jobs_pubsub.py` — multi-subscriber, late join (subscribe-first then snapshot)
8. `test_jobs_api_resubscribe.py` — disconnect at variant 2, reconnect with Last-Event-ID, no duplicates, no missing
9. `test_jobs_api_dedupe.py` — simultaneous identical POST → same id (DuplicateKeyError race)
10. `test_jobs_api_security.py` — owner check (404 not 403), input path validation
11. `test_jobs_api_pagination.py` — list with cursor
12. `test_jobs_lifecycle_parity.py` — old endpoint vs new endpoint produce byte-equal disk + Mongo state
13. `test_jobs_dual_mode.py` — Phase C feature flag both ON/OFF

### Frontend
14. `jobSubscription.test.ts` — start/stop, HMR cleanup, reconnect on activeJobId change
15. `streaming-prev-preservation.test.tsx` — Bug A 회귀
16. `step-navigation-resume.test.tsx` — Bug B 회귀
17. `reload-survive.test.tsx` — persist activeJobId, mount → snapshot fetch + events
18. `useHostGeneration-store-selector.test.tsx` — hook은 store에서만 read
19. `crosstab-cancel.test.tsx` — Tab1에서 active job, Tab2에서 새 POST → Tab1 SSE에 cancelled

### E2E (Cypress)
20. cold start → Step 2 round-trip → 결과 그대로
21. cold start → reload → 결과 그대로
22. dual-mode (flag toggle) → 양쪽 path 모두 동작

---

## 10. 작업 순서 (commits) — v3 최종

각 commit 독립적으로 green, bisectable.

### Phase A — Backend (1.5–2주)
1. `feat(db): generation_jobs table + repository (studio_008)`
2. `feat(jobs): JobRunner class + startup recovery + heartbeat sweep`
3. `feat(api): POST /api/jobs (host kind) + dedupe semantics`
4. `feat(api): POST /api/jobs (composite kind)`
5. `feat(api): GET /api/jobs/:id snapshot`
6. `feat(events): JobsPubSub + sse_format helper`
7. `feat(api): GET /api/jobs/:id/events SSE with seq + Last-Event-ID`
8. `feat(api): DELETE /api/jobs/:id with conditional update`
9. `feat(api): GET /api/jobs cursor pagination`
10. `feat(jobs): mark_ready_with_lifecycle consolidation`
11. `chore(api): single-process fail-fast assertion`
12. `chore(api): deprecate /api/host/generate/stream + composite/generate/stream` (still active behind flag)

### Phase B — Frontend (1주)
13. `chore(schema): HostGeneration discriminator → idle | attached(jobId)` (v9)
14. `feat(stores): jobCacheStore + jobSubscription module + HMR cleanup`
15. `feat(api): client functions for /api/jobs/* + SSE parser`
16. `refactor(hooks): useHostGeneration → store selector`
17. `refactor(hooks): useCompositeGeneration → store selector`
18. `feat(step1): preserve prev tile during streaming` (UI gate change)
19. `feat(topbar): pill micro-spec + multi-job panel` (design-spec §2 따름)
20. `feat(ui): re-roll confirm + cancel undo toast` (design-spec §3)
21. `feat(a11y): live region + radiogroup keyboard nav` (design-spec §6)
22. `chore: delete useHostStream Lane F (no production consumers)`
23. `chore: feature flag VITE_USE_JOBS_API`

### Phase C — Cutover & cleanup (1주 soak + 3일)
24. enable flag for all users, monitor 7 days
25. `chore(api): remove /api/host/generate/stream + composite/generate/stream`
26. `chore(frontend): remove flag + dual-mode branches`

### Phase D — Tests & docs
27-46. 19 test files (위 §9), 각각 별도 commit
47. `docs: TODOS.md update + post-merge follow-ups`

총 ~47 commits, 4-5주 (이전 추정 3-4주에서 spec 정확도 반영 후 +1주 buffer).

---

## 11. v2.1 Future (본 PR 범위 외)

- Redis pubsub → multi-worker scale
- HistoryView (`GET /api/jobs?kind=host&state=ready` + thumbnail grid)
- TopBar panel cross-step navigation
- Cross-tab BroadcastChannel coordination
- Step 3 (audio/render) lifecycle 동일 패턴 적용
- 7일 TTL cron job
- Orphan file GC (cancelled/failed job의 disk 정리)
- Generation cost / quota 추적
- Server-pushed toast notification on done (다른 step에 있을 때)

---

## 12. 사용자가 명시 결정해야 할 항목 (open)

이 spec은 4 voices가 짚은 모든 high/critical 해소했지만 다음은 사용자 product 결정.

1. v8 → v9 마이그레이션이 모든 state를 idle로 reset함. 사용자 in-flight 작업 손실 가능. 수용 가능?
2. cancelled job의 partial files를 history에서 retrieve 가능 (ready/failed와 동일하게). 사용자 의도와 일치?
3. SSE per-user cap 10개 — 일반 사용자는 한 번에 1-2개 쓸 텐데 10개는 적절한 margin?
4. Phase C soak 1주 — 더 길게 / 짧게 / cohort-by-cohort?
5. 본 PR scope에서 Step 3 적용을 분리하는 것 — Step 3도 같은 lifecycle 결함 있다면 한 번에 묶을 가치?

이 5개는 implement 시작 전 product owner 결정.

---

## 13. plan v2 → v3 갱신 사항

이 spec 반영 후 `streaming-resume-plan.md`에 갱신할 항목:
- §4 (Backend 변경) → 본 spec §2-§7로 대체
- §5 (Frontend 변경) → 본 spec §3.4 (jobSubscription) + design-spec §1 (UI states)로 보강
- §9 (구현 순서) → 본 spec §10으로 대체 (commits 47개)
- §8 (Test) → 본 spec §9로 확장

이 두 spec 문서가 plan v2의 implementer-ready 충족 조건. 다음 단계는 `git push origin feat/streaming-resume` 후 PR로 전체 검토.
