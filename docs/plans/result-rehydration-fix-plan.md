# Result page rehydration fix — host/composite/audio + queue scope

## Symptoms (reported 2026-04-29)

1. `/result/:id` — 1단계(host) + 2단계(composite) 썸네일이 깨짐.
2. "수정해서 다시 만들기" 로 wizard에 복귀해도 같은 두 이미지가 깨짐.
3. result에서 만든 오디오를 못 불러옴.
4. (해결 완료) 큐 패널이 user 무관하게 모든 작업 노출 — `/api/queue` 의
   admin/master role bypass 제거 (`app.py:3026-3033`).

## Root causes (DB inspection 기반)

샘플 row: `studio_results` task_id `dee48a11…`, owner `jack`.

```
params.host_image: /opt/home/jack/workspace/SoulX-FlashTalk/temp/job-input-0ijpnxad.png
params.audio_path: /opt/home/jack/workspace/SoulX-FlashTalk/temp/job-input-1kra6bqs.wav
params.audio_url:  None
params.audio_key:  None
meta.host.imageUrl:        https://...?X-Amz-Expires=3600... (1시간 후 403)
meta.composition.selectedUrl: https://...?X-Amz-Expires=3600... (만료)
```

### Cause A — Worker가 manifest `params`에 temp 절대경로를 덮어 씀

`app.py:912-917`:
```python
host_image = await asyncio.to_thread(_resolve_input_to_local, host_image, ...)
audio_path = await asyncio.to_thread(_resolve_input_to_local, audio_path, ...)
```

위 두 줄이 inference subprocess용 로컬 파일 path로 **로컬 변수 자체를 덮어씀**.
이후 `app.py:1221-1232` (성공 분기) + `app.py:1302-1313` (실패 분기) 가 그 덮인
변수를 manifest `params.host_image` / `params.audio_path` 에 그대로 저장.

원본 storage_key (`outputs/composites/...png`, `outputs/audio/tts_xxx.wav`) 는 손실됨.

**파급:**
- `_ensure_manifest_urls` 의 audio enrichment 가 `_normalize_to_storage_key`
  단계에서 None 반환 → `params.audio_url` 미발급 → 오디오 깨짐.
- `ProvenanceCard.compositeUrl = outputsPathToUrl(params.host_image) ||
  c.selectedUrl` — 첫 분기 실패하고 만료된 `c.selectedUrl` 로 fallback.
- `doEditAndRetry` 가 `audioPath = params.audio_path` 를 그대로 wizard
  voice 슬라이스에 주입 → step3 audio key 가 temp 경로 → 재 dispatch 시
  worker 가 그 경로 resolve 실패하거나 같은 손상이 재현.

### Cause B — Read 시점 host/composition presigned URL re-mint 누락

`app.py:3180 _ensure_manifest_urls` 는 다음만 enrich:
- `meta.background.url`
- `params.audio_url`
- `meta.products[].url`

`meta.host.imageUrl` / `meta.composition.selectedUrl` 은 **dispatch 시점에
저장된 정적 presigned URL** (`X-Amz-Expires=3600`, 1시간 TTL). 1시간 후엔
403/404 — ProvenanceCard 가 `<img src>` 에 그대로 박으니 result 진입 시
바로 깨짐. 같은 만료 URL 이 `doEditAndRetry` 의 wizard variant `url`
필드에 들어가 step1/step2 그리드도 동시에 깨짐.

## Plan

> **Note (semantics):** `params.host_image` 는 의미상 **"FlashTalk 최종 conditioning frame"**.
> 보통 step2 composite 의 storage_key 이지만, scene_prompt 분기 (Gemini 백엔드
> 합성) 가 활성화되면 새로 합성된 composite 로 교체됨. Plan 의 fix 들이 이
> 의미를 보존하도록 설계.

### Fix 1 — Worker manifest 에 원본 storage_key 보존 (Cause A)

**Where:** `app.py` `_queue_generate_handler` / generate worker (lines ~870-1320 영역).

**Approach:** `_resolve_input_to_local` 호출 전에 원본 인자 값을 별도
지역변수로 capture, manifest 직렬화 시 *원본*을 박는다. scene_prompt 분기가
host_image 를 새로 합성된 composite 로 교체하면 그것을 outputs/composites/
storage_key 로 정규화 후 manifest 에 박는다 (실제 사용된 frame 보존).

```python
# Before _resolve_input_to_local() shadows the names.
host_image_key_for_manifest = host_image     # storage_key as received
audio_key_for_manifest = audio_path           # ditto
ref_paths_key_for_manifest = list(reference_image_paths or [])

host_image = await asyncio.to_thread(_resolve_input_to_local, host_image, input_cleanup)
audio_path = await asyncio.to_thread(_resolve_input_to_local, audio_path, input_cleanup)
# (resolved local paths from this point on — `host_image` is local fs path)

...

# scene_prompt 분기 (Gemini): host_image 가 composed_path 로 교체될 수 있음.
# 합성 후 outputs/composites/<basename> 으로 storage upload + manifest 갱신.
if scene_prompt and scene_prompt.strip():
    ...
    if composed_path and os.path.exists(composed_path):
        host_image = composed_path  # local fs path used for FlashTalk
        # Promote into storage so manifest can record the actual frame.
        composed_key = f"outputs/composites/{os.path.basename(composed_path)}"
        _upload_video_with_retry(composed_path, composed_key)  # reuse helper
        host_image_key_for_manifest = composed_key
...

manifest = {
    ...
    "params": {
        "host_image": host_image_key_for_manifest,
        "audio_path": audio_key_for_manifest,
        ...
        "reference_image_paths": ref_paths_key_for_manifest,
    }
}
```

같은 fix 를 실패 분기(`persist_terminal_failure` 호출) 의 `params=` 인자
에도 적용. 단, 실패 분기는 scene_prompt 가 합성을 *완료* 못 한 경우도 있어
원본 storage_key 그대로가 안전 (composed_path 가 없을 수 있음).

**Sibling fix (`/api/generate` ElevenLabs 분기 — `app.py:2150-2188`):**
현재 frontend 가 사용 안 하지만 dead code 가 아니라 활성. 현재 audio_path 가
`config.TEMP_DIR` 에 떨어짐 → enqueue 시점부터 queue params 에 temp 절대경로.
TTS-generate 정상 endpoint (`app.py:1907-1935`) 와 동일하게 OUTPUTS_DIR 로
저장 + `_upload_local_to_storage` 통과 후 storage_key 로 queue 에 전달.
~5줄 변경. 이게 안 들어가면 cancel_task 가 cancelled job 의 queue params 를
studio_results 에 persist 할 때 corrupt row 발생 가능 (현재는 frontend 가
upload 만 쓰므로 이론적 위험).

**Backfill (이 PR 에 포함):** `scripts/backfill_manifest_keys.py` —
1회용 스크립트, 손상된 모든 row 에 대해 다음 우선순위로 복구:

1. `params.host_image` temp 절대경로 →
   - `generation_jobs.params.host_image` 가 살아있고 storage_key 형태면 그것
   - 아니면 `meta.composition.selectedPath` (composite 우선)
   - 아니면 `meta.host.selectedPath`
   - 다 없으면 None.
2. `params.audio_path` temp 절대경로 →
   - **`generation_jobs.params.audio_path` cross-check** (codex finding #5
     검증됨: 실제 dev DB 에서 storage_key 형태로 살아있음). 발견되면
     `outputs/...` storage_key 로 복구.
   - generation_jobs 가 prune 된 row 만 None 으로 정리. 사용자 영향: 일부
     손상 row 의 audio 가 복구되고, 나머지만 result 에서 빈 audio 상태로
     "음성 만들기" 다시 클릭 필요.
3. `params.reference_image_paths` 가 temp 절대경로 → 빈 리스트.

Dry-run / live 두 모드 + per-row diff 출력. 실패 시 row skip 후 logging,
나머지는 진행. 트랜잭션 처리 안 함 (idempotent).

DB inspection 결과 (2026-04-29):
- studio_results 손상 row 2건 (`dee48a11…`, `48747275…`).
- `48747275…` 는 generation_jobs 에 원본 살아있음 → host+audio 완전 복구.
- `dee48a11…` 는 generation_jobs row 없음 → meta.host/composition 으로 image
  복구, audio 만 None.
Prod 영향은 backfill 실행 시점에 동일 쿼리 재확인.

### Fix 2 — `_ensure_manifest_urls` 에 host/composition 분기 추가 (Cause B)

**Where:** `app.py:3180-3250 _ensure_manifest_urls`.

**Approach:** background/products/audio 패턴 *수정* + host/composition *추가*.

핵심 변경: 기존 `if not params.get("audio_url"):` 류의 "missing only" 분기를
**무조건 재발급** 으로 바꾼다. presigned URL 은 매 read TTL 새로 발급해야
정확함 — 기존 stored URL 도 stale 일 수 있음 (codex finding #2).

```python
# audio (수정)
audio_ref = (
    params.get("audio_key")
    or params.get("audio_storage_key")
    or params.get("audio_path")
)
if audio_ref:
    url = _media_url(audio_ref)
    if url:
        params["audio_url"] = url   # always overwrite (TTL re-mint)

# background.url (수정)
if bg and bg.get("source") == "upload":
    bg_ref = bg.get("key") or bg.get("storage_key") or bg.get("uploadPath") or bg.get("imageUrl")
    if bg_ref:
        url = _media_url(bg_ref)
        if url:
            bg["url"] = url   # always overwrite

# products[].url (수정)
for p in products:
    p_ref = p.get("key") or p.get("storage_key") or p.get("path")
    if p_ref:
        url = _media_url(p_ref)
        if url:
            p["url"] = url   # always overwrite

# host (NEW)
host = meta.get("host") if isinstance(meta.get("host"), dict) else None
if host:
    host_ref = host.get("selectedPath") or host.get("key") or host.get("storage_key")
    if host_ref:
        url = _media_url(host_ref)
        if url:
            host["imageUrl"] = url    # ProvenanceCard reads
            host["url"] = url          # wizard variant
        # frontend reads `selectedPath` for rehydrate; populate from key
        # if legacy row only has key (codex finding #10).
        if not host.get("selectedPath"):
            key = _normalize_to_storage_key(host_ref)
            if key:
                host["selectedPath"] = key
                host["key"] = key

# composition (NEW)
comp = meta.get("composition") if isinstance(meta.get("composition"), dict) else None
if comp:
    comp_ref = comp.get("selectedPath") or comp.get("key") or comp.get("storage_key")
    if comp_ref:
        url = _media_url(comp_ref)
        if url:
            comp["selectedUrl"] = url
            comp["url"] = url
        if not comp.get("selectedPath"):
            key = _normalize_to_storage_key(comp_ref)
            if key:
                comp["selectedPath"] = key
                comp["key"] = key
```

매 read 마다 새 URL을 발급하므로 멱등 + TTL 무관. 기존 stale URL은 항상
덮어 씀.

**In-place mutation note (codex finding #11):** 현재는 Mongo find 마다 fresh
dict 라 안전. 미래에 result repo caching 추가되면 presigned URL 이 캐시에
새는 위험 → 그때 `copy.deepcopy(doc)` 로 전환. 지금 plan 에는 미적용.

### Fix 3 — Frontend `doEditAndRetry` rehydrate 우선순위 변경

**Where:** `frontend/src/studio/ResultPage.tsx:121-412 doEditAndRetry`.

현재는 `meta.host.selectedPath`, `meta.composition.selectedPath` 를 *이미*
읽고 있음 (코드 검수: line 152, 224). 즉 host/composition 의 image variant
복원은 meta 우선이 이미 동작 — 깨졌던 건 거기서 함께 들고온 만료된
`hostSelectedUrl` (meta.host.imageUrl) 이 variant.url 로 들어가 step1 그리드
이미지가 stale URL 이었던 점. **Fix 2 가 read 시점 imageUrl 을 새 URL 로
덮으므로 자동 해결.** Frontend 의 rehydrate 로직은 추가 변경 없음.

Audio 만 가드 추가:

```ts
// 우선순위:
// 1) params.audio_key (Fix 1 이후 정상 storage_key)
// 2) params.audio_path 가 storage_key 형태이면 그것 (Fix 1 이후 / 정상 row)
// 3) 둘 다 없거나 temp 절대경로면 → audioAsset = null, voice.generation = idle
const looksLikeStorageKey = (s: unknown): s is string =>
  typeof s === 'string' && /^(outputs|uploads|examples)\//.test(s);

const audioKey =
  (typeof params.audio_key === 'string' && params.audio_key) ||
  (looksLikeStorageKey(params.audio_path) ? params.audio_path : '');
const audioUrl = typeof params.audio_url === 'string' ? params.audio_url : '';
const audioAsset = audioKey
  ? { key: audioKey, url: audioUrl, name: audioKey.split('/').pop() ?? '' }
  : null;
```

Backfill 안 된 손상 row (audio 영구 손실) 진입 시 step3 가 빈 voice
generation 상태로 떨어져 "음성 만들기" 다시 누르면 됨. Backend Fix
1+2+backfill 까지 들어간 이후엔 정상 row 100% — 가드는 미래 회귀 보호용.

ProvenanceCard 변경 없음 — Fix 2 가 `meta.host.imageUrl` 을 매 read 새로
발급하므로 ProvenanceCard 의 `<img src={h.imageUrl}>` 그대로 동작.

## Test plan

### Backend unit (`tests/test_ensure_manifest_urls.py` 신규)

**Critical (REGRESSION):**
- `test_ensure_manifest_urls__host_imageUrl_overwritten_when_stale`:
  meta.host 가 selectedPath + 만료된 imageUrl 둘 다 갖는 row → 새 URL 로
  덮어쓰기 검증. Composition 도 동일.
- `test_ensure_manifest_urls__audio_url_overwritten_when_stale`:
  params 에 audio_path + 만료된 audio_url 둘 다 → 매번 새 URL.
  background.url, products[].url 동일.
- `test_worker_manifest_preserves_original_storage_keys`:
  `_resolve_input_to_local` mock 으로 절대경로 반환시켜도 manifest
  `params.host_image` / `params.audio_path` 에 원본 storage_key 들어감.
  성공 분기 + `persist_terminal_failure` 분기 둘 다.
- `test_worker_manifest_records_composed_path_when_scene_prompt`:
  scene_prompt 활성 분기에서 host_image 가 composed_path 로 교체되어도
  manifest `params.host_image` 가 outputs/composites/<basename> 형태인지.
- `test_elevenlabs_branch_writes_to_outputs`: `/api/generate?audio_source=elevenlabs`
  로 호출 시 queue params 의 audio_path 가 outputs/ storage_key 인지.

**Standard:**
- host/composition 분기 idempotency (두 번 호출 = 한 번 호출과 동일 결과).
- storage_key prefix 다양성: `outputs/composites/`, `outputs/hosts/saved/`,
  `uploads/`, `examples/`.
- selectedPath 만 있는 row → imageUrl 발급.
- 둘 다 없는 row → meta 변경 무.
- legacy `imageUrl` 필드만 있고 selectedPath 없는 row → 변경 무 (보수적).

### Backend integration (`tests/test_api_results_enrichment.py` 신규)

핵심: 실제 storage backend 가 아니라 fake `media_store.url_for` (incrementing
counter sentinel) 를 주입해서 검증. X-Amz-Date 같은 초 레이스 + LocalDisk
케이스 모두 회피 (codex finding #12).

- fake url_for 가 호출마다 `https://stub/<key>?v=<n>` 같은 sentinel 반환.
- 손상 row fixture → `GET /api/results/<id>` → `meta.host.imageUrl` 의 v 가
  call 1 vs call 2 사이에 증가하는지 검증 (= 매번 재발급).
- background.url, products[].url, audio_url, composition.selectedUrl 동일.
- legacy `key`-only host/composition row → `selectedPath` 가 enrichment 후
  채워지는지.
- scene_prompt 미설정 row 정상 동작 회귀 가드.

### Frontend unit (`frontend/src/studio/__tests__/result_page_rehydrate.test.tsx` 확장)
- `doEditAndRetry`: params.audio_path 가 temp 절대경로 → voice generation
  idle, audio asset null.
- params.audio_key 와 audio_path 둘 다 storage_key → audio_key 우선.
- `looksLikeStorageKey` 단위 테스트 (outputs/uploads/examples 통과, /opt/.../temp 거부).

### Backfill script (`tests/test_backfill_manifest_keys.py` 신규)
- Dry-run: 손상 row fixture 에서 어떤 key 가 어떻게 바뀌는지 stdout 검증,
  DB 미변경.
- Live: 같은 fixture 에 적용 후 DB 상태 검증.
- Idempotency: 두 번 돌려도 안전.
- generation_jobs cross-check: 살아있는 audio_path / host_image storage_key
  를 우선 사용해서 복구.
- generation_jobs 가 없는 row 의 audio 만 None 으로 정리, host/composition
  은 meta 에서 복구.

### Browser smoke
- 손상 row 의 result/:id 진입 → 1·2단계 썸네일 표시 (Fix 2 + backfill 효과).
- 정상 row 도 1시간 + 후 재진입 → 이미지 유지 (signed URL re-mint).
- 손상 row "수정해서 다시 만들기" → step1/step2 그리드 카드 표시, step3
  audio 는 빈 상태에서 "음성 만들기" 다시 클릭 가능.
- 신규 dispatch 한 작업의 manifest DB 직접 확인:
  `params.host_image = outputs/composites/...png`,
  `params.audio_path = outputs/...wav`.

## Out of scope

- 큐 admin override (이미 제거됨, 별도 commit).
- studio_results schema cleanup (video_path/video_filename/video_url 중복,
  audio_source_label 중복 등). 별도 plan 필요.
- ElevenLabs `/api/generate` 분기 *제거* (현재 plan 은 *보호 적용*, 제거는
  별도 PR — frontend dead code audit 동반).
- result repo response caching + presigned URL 격리 — 미래 최적화 시 별도
  검토.

## Risk / rollback

- Fix 2 는 read-only enrichment 추가, 기존 동작 변경 없음 → 안전.
- Fix 1 은 manifest write 형태 변경 — 기존 row 영향 없음, 새 row 만 영향.
  Backfill 은 별 commit 으로 분리하면 롤백 단순.
- 모두 한 PR 로 묶어도 git revert 한 방으로 원복.
