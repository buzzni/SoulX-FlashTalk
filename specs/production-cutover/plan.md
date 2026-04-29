<!-- /autoplan restore point: /opt/home/jack/.gstack/projects/buzzni-SoulX-FlashTalk/main-autoplan-restore-20260429-162232.md -->
# Production Cutover — S3 완성 + 분리 배포 가능 구조

> 상태: 📋 **draft for /plan-eng-review**
> 작성일: 2026-04-29
> 관련: [s3-migration/plan.md](../s3-migration/plan.md) (PR S3+ C1-C13 완료), TODOS.md S3 cutover follow-ups, LocalDisk audit 38 finding (1 BLOCKER)

## 문제 정의

PR S3+ (`C1-C13` + fixes, 18 커밋, 2026-04-28~29 main 랜딩) 으로 LocalDisk → AWS S3 마이그레이션 본체는 끝났다. 하지만:

1. **🚨 BLOCKER 1건** — `app.py:3834` `delete_video`가 S3 모드에서 `local_path_for()` 호출 → `NotImplementedError`. `DELETE /api/videos/{task_id}` 가 프로덕션에서 500.
2. **S3 prefix 평면 누적** — `outputs/` 한 prefix에 video(`<task_id>.mp4`) + audio(TTS `<hash>.wav`) + image(`outputs/hosts/saved/*`, `outputs/composites/*`) 다 섞여있어 lifecycle 정책 적용 불가, task 단위 audit/삭제/zip 다운로드 불가.
3. **LocalDisk-only 잔재 38건** — audit 결과 (`audit-2026-04-29.md` 참조). 이 중 NEEDS_VERIFICATION 24건이 프론트엔드 분리 배포 환경에서 silently 깨지거나 dead-end 응답.
4. **분리 배포 invariant 부재** — 프론트가 백엔드와 다른 호스트로 빌드/배포될 때, `/static` mount(`app.py:88`), 절대 path를 frontend가 string-mangle하는 `outputsPathToUrl`(`format.ts:30`), filesystem-probe-only `/api/files` 분기(`app.py:3068-3094`) 등이 작동 보장 없음.

**근본 질문**: (a) 배포 환경에서 깨지는 모든 코드 경로 제거, (b) S3 구조를 task_id 그룹으로 재설계해서 lifecycle/audit/cost 통제 가능하게, (c) 모노레포 분리 가능한 invariant — backend 라이브 코드가 frontend 와 같은 filesystem을 가정하지 않도록, (d) PR S3+ 종료 후 잔존하는 dual-input 호환 코드 정리.

---

## 현재 상태 사실 정리

### 현행 S3 prefix 구조

```
ailab-demo/dev/soulx-flashtalk/
├── uploads/             ← 평면, uuid 기반 (host_/bg_/ref_/audio_)
├── outputs/             ← video(.mp4) + audio(.wav) + image 섞임
│   ├── <task_id>.mp4
│   ├── <hash>.wav
│   ├── hosts/saved/<file>.png
│   └── composites/<file>.png
└── examples/            ← seed assets
```

### Result 페이지 fetch 흐름 (확인됨)

`/api/videos/{task_id}` (`app.py:2247-2308`), `/api/files/{filename}` (`app.py:3025-3094`) 모두 **S3 모드에서 302 redirect to presigned URL** (TTL 6h video / 별도 image). 백엔드 stream 안 함. 표준 best-practice 패턴이라 그대로 유지.

### 프론트엔드 분리 배포 가능성

- `API_BASE = VITE_API_BASE_URL` (`http.ts:18`) — env 주입 OK
- CORS allow_origins config (`app.py:62-63, config.CORS_ORIGINS`)
- 모든 fetch가 `API_BASE` 경유, hardcoded 백엔드 URL 없음
- client-side ML 의존성 0개 (transformers/onnx/tensorflow/mediapipe 모두 없음)
- 추론 100% 백엔드 호출 (Gemini/ElevenLabs/FlashTalk/MuseTalk/rembg 모두 backend-only)

**결론**: 분리 배포 자체는 가능. 다만 위 38건 + S3 prefix 재설계가 prerequisite.

### 38건 audit 카테고리 (요약)

| 위험도 | 건수 | 핵심 |
|---|---|---|
| BLOCKER | 1 | `delete_video` S3 incompat |
| 프론트 silently 깨짐 | 6 | `outputsPathToUrl`, `ResultPage path-mangling`, `isServerAsset` discriminator, `task_states` cleanup, `/api/files` bare-name probe, `_synthesize_result_from_queue` filesystem listdir |
| 디스크 누적 | 3 | TTS/video/conversation OUTPUTS_DIR 영구 잔존 |
| SAFE_TO_REMOVE quick wins | 6 | dead url construction, dummy 인자, RESULTS_DIR, key_from_path branch 등 |
| 검증 후 제거 | 9 | 호환용 dual-input 잔재 |
| 의도된 유지 | 7 | LocalDisk dev/CI startup, 단위 테스트, intentional staging |
| 문서 drift | 6 | LocalDisk 가정한 docstring/comment |

---

## 제안 — S3 구조 재설계: 옵션 C 하이브리드

### 새 prefix layout

```
ailab-demo/dev/soulx-flashtalk/
├── uploads/<user_id>/<asset_id>.<ext>      ← 재사용 자산 (host face/outfit ref, voice clone source)
│
├── tasks/<task_id>/
│   ├── inputs/<asset>.<ext>                 ← 1회용 참조 (composite product image 등)
│   ├── outputs/host_<seed>.png              ← step1 host candidate 4장
│   ├── outputs/host_<seed>.meta.json        ← sidecar (seed/prompt/negative)
│   ├── outputs/composite_<seed>.png         ← step2 composite candidate 4장
│   ├── outputs/composite_<seed>.meta.json   ← sidecar
│   ├── outputs/audio.wav                    ← step3 TTS 결과
│   └── outputs/video.mp4                    ← 최종 영상
│
└── examples/<filename>                       ← seed assets (전과 동일)
```

### 선택 근거

- **lifecycle 정책 분리**: `tasks/` 30일 TTL 자동 삭제, `uploads/` 영구, `examples/` 영구. AWS S3 Object Lifecycle 한 prefix 단위로 적용 가능.
- **task 단위 audit·삭제·다운로드**: `aws s3 rm s3://bucket/.../tasks/<task_id>/ --recursive` 한 줄로 삭제. "내 영상 다운로드" → 해당 task 단일 ZIP.
- **사용자 자산 보존**: host face / voice clone 같은 재사용 자산은 task 라이프사이클과 분리 (`uploads/<user_id>/`).
- **현 코드 변화 작음**: `_upload_local_to_storage` 헬퍼와 generator의 `output_dir` 인자가 이미 prefix 추상화 되어있어 key 생성 규칙만 바꾸면 됨.
- **inputs/outputs 분리**: 재계산 시 `outputs/` 만 비우고 `inputs/` 보존 가능. 디버깅·감사 친화.

### 대안 (rejected)

- **옵션 A — kind별 평면**: `videos/`, `audios/`, `images/`. lifecycle 정책 단순하지만 task 단위 묶음 불가. → 사용자 다운로드 UX 약하고 audit 어려움.
- **옵션 B — 순수 task_id**: 사용자 재사용 자산도 task로 묶음. → 동일 host 재사용 시 중복 업로드 발생, 비용 손해.

---

## 4 PR 분해

### PR-0 — 🚨 BLOCKER fix: `delete_video` S3 호환

**Scope** (XS, ~30 lines):
- `app.py:3834` `delete_video`: `local_path_for()` 호출을 `media_store.delete(storage_key)` 로 교체.
- 로컬 mp4 cleanup은 `task_states[task_id]["output_path"]` 기반 best-effort `os.unlink` (있으면 지움, 없으면 skip).
- 백엔드 테스트: `tests/test_api_videos.py` (신규) — S3 mock(moto)으로 `DELETE /api/videos/{task_id}` 200 + S3 객체 삭제 검증, LocalDisk 모드도 회귀 가드.

**위험**: 매우 낮음. 단일 endpoint, 호출 1건, 테스트 가능.

**의존성**: 없음. 즉시 진행 가능.

---

### PR-1 — S3 prefix 재설계: task_id grouping (write-side cutover)

**Scope** (M, ~200 lines + tests):

#### 1.1 prefix 헬퍼 도입
`modules/storage.py` 또는 신규 `modules/storage_keys.py`:
```python
def task_input_key(task_id: str, asset_name: str) -> str:
    return f"tasks/{task_id}/inputs/{asset_name}"

def task_output_key(task_id: str, asset_name: str) -> str:
    return f"tasks/{task_id}/outputs/{asset_name}"

def user_upload_key(user_id: str, asset_id: str, ext: str) -> str:
    return f"uploads/{user_id}/{asset_id}{ext}"
```

#### 1.2 write-side 호출처 마이그레이션
- `app.py:1168, 2690` (video mp4): `outputs/<task_id>.mp4` → `tasks/<task_id>/outputs/video.mp4`
- TTS audio (`app.py:1825, 1834` 부근): `outputs/<hash>.wav` → `tasks/<task_id>/outputs/audio.wav`
- step1 host generation (`host_generator._upload_local_to_storage`): `outputs/hosts/saved/...` → `tasks/<task_id>/outputs/host_<seed>.png`
  - 단, "saved host (나의 쇼호스트)" 는 사용자 라이브러리이므로 `uploads/<user_id>/saved_hosts/<id>.png` 로 분리 (memory `saved_host_design`에 따라)
- step2 composite (`composite_generator._upload_local_to_storage`): `outputs/composites/...` → `tasks/<task_id>/outputs/composite_<seed>.png`
- step1 user upload (`app.py:1471, 1485, 1538, 1570, 1711, 1764`): `uploads/host_<uuid>.png` → `uploads/<user_id>/<uuid>.png` (또는 user_id 없는 anon은 `uploads/anon/<uuid>.png`)

#### 1.3 read-side dual-compat
- 기존 데이터를 위해 storage_key 형태 그대로 read 가능하게 유지 (이미 `validate_key` 가 prefix 가정 안 함).
- 마이그레이션 스크립트는 **선택 사항** — 일정 기간 dual-read 후 옛 데이터 lifecycle로 자연 만료.

#### 1.4 task_id 가용성 확인
- 현재 코드에서 generation 시점에 `task_id` 가 wired 되어있는지 검토.
- step1 host 생성은 task_queue 진입 전이라 task_id 없음 → "draft task_id" or 별도 처리 필요. 검토 항목.

**의존성**: PR-0 끝나야 시작 (delete_video 의 S3 호환이 prefix 재설계의 read-side 가정).

**검증**: 기존 tests/test_storage_s3.py + 신규 test_storage_keys.py + 통합 테스트.

---

### PR-2 — 프론트엔드 분리 배포 깨짐 6건 + SAFE_TO_REMOVE 6건

**Scope** (M, frontend + backend 양쪽):

#### 2.1 프론트엔드 silent break 수정
- `frontend/src/lib/format.ts:30-52` `outputsPathToUrl` — 절대경로 string-mangling 제거. backend response의 `url` 필드 우선 사용, fallback으로 `storage_key` 만 받아서 `/api/files/<storage_key>` 구성.
- `frontend/src/studio/ResultPage.tsx:205,272-340` — `path.split('/').pop()` 으로 bucket-less filename 만드는 패턴 제거. backend가 보내는 `url` 직접 사용.
- `frontend/src/wizard/normalizers.ts:54` `isServerAsset` discriminator — `storage_key` 도 인정하도록 확장.
- `frontend/src/api/composite.ts:43`, `frontend/src/api/video.ts:60-78` — form 필드명 `*Path` → `*Key` 로 rename (backend 이미 dual-input 처리하므로 wire 호환).

#### 2.2 백엔드 frontend-deploy invariant
- `app.py:88-89` `app.mount("/static", StaticFiles(...))` 제거. 분리 환경에선 무용 + CSO smell (audit + review-findings M5).
- `app.py:2247-2257` `task_states[task_id]["output_path"]` post-upload cleanup — 업로드 성공 후 dict entry 삭제 또는 None 마킹.
- `app.py:2898-2925` `_synthesize_result_from_queue` `os.listdir(OUTPUTS_DIR)` → `media_store.list_prefix("tasks/")` 또는 fallback 제거하고 unsynthesizable rows는 그냥 404.
- `app.py:3068-3094` `/api/files/{filename}` — bare-name legacy probe 제거 (Mongo의 옛 row를 일회성 스크립트로 storage_key 형태로 backfill 후 dead code 삭제).

#### 2.3 SAFE_TO_REMOVE quick wins (audit 결과)
- `frontend/src/types/generated/api.d.ts` 재생성 (백엔드 재시작 후 `npm run gen:types`)
- `modules/host_generator.py:161,272`, `modules/composite_generator.py:652,794` — dead `url` 필드 generator return shape에서 제거 (`_upload_local_to_storage` 가 덮어씀)
- `app.py:914,1663,2571,2591` — `os.path.join(UPLOADS_DIR, "dummy")` sentinel 인자 제거
- `modules/repositories/studio_host_repo.py:191-199` — `key_from_path` legacy branch 삭제 (호출처 모두 이미 storage_key 전달)
- `config.py:22` `RESULTS_DIR` + `app.py:85` makedirs 제거 (PR5 이후 manifest는 Mongo)
- `modules/storage.py:447-454` `legacy_path_for()` — 프론트가 `path` 안 읽게 되면 동시 제거

#### 2.4 generated artifact: api.d.ts 재생성
- 백엔드 재시작 → `npm run gen:types` → stale `/api/upload/list` 타입 정리

**의존성**: PR-1 의 prefix 재설계가 끝나야 frontend가 새 storage_key 형태 받게 됨 (안 그러면 frontend 변경이 옛 prefix 계속 처리해야 함).

---

### PR-3 — 분리 배포 검증 + 잔재 정리

**Scope** (S–M):

#### 3.1 디스크 누적 fix (TODOS #3)
- TTS/video/conversation 출력의 post-upload `os.unlink` 또는 cron-based cleanup
- `task_queue._repair_completed_without_mp4` (`task_queue.py:340-369`) — S3 모드에서 dangerous (정상 row를 error로 마크 가능). gate 또는 제거.

#### 3.2 LocalDisk-only branch 정리 (audit 카테고리 2)
- `app.py:2293-2305` LocalDisk fallback in `/api/videos`
- `app.py:2308-2311` `legacy_path` (`video_path`) fallback
- `modules/storage.py:457-478` `resolve_legacy_or_keyed` 함수 자체

#### 3.3 분리 배포 smoke test
- 프론트 빌드를 다른 origin (예: `localhost:5556`) 에서 서빙, `VITE_API_BASE_URL=http://localhost:8001` 로 백엔드 호출
- step1~step3 풀 플로우 + result 페이지 영상 재생 + 다운로드 + 삭제 검증
- CORS preflight 통과 확인
- presigned URL redirect chain 정상 (302 → S3) 확인

#### 3.4 docstring/comment cleanup (audit 카테고리 6)
- `format.ts:33-37`, `image_compositor.py:589-597`, `app.py:88` 등 docstring drift 수정

**의존성**: PR-2 끝나야 시작 (frontend 변경 + storage prefix 새 구조 모두 가정).

---

## Out of scope

- **데이터 마이그레이션 스크립트** — 옛 `outputs/<task_id>.mp4` → `tasks/<task_id>/outputs/video.mp4` 이동 스크립트는 별도 lane. dual-read만 영구 유지해도 동작.
- **lifecycle 정책 IaC** — `tasks/` 30일 TTL 등은 Terraform/CloudFormation 별도 PR 또는 콘솔 수동 설정.
- **CDN 도입** — 프론트가 분리되면 CloudFront 가 자연스럽지만 이번 plan 범위 밖.
- **Multi-region S3** — bucket 1개 (`ailab-demo`) 그대로.
- **opt B — pure task_id grouping (사용자 자산 포함)** — rejected, 위 옵션 C가 정답.
- **frontend route-level lazy-load** — 별도 perf lane (#10 backlog).
- **composite generator의 진단 로거 제거** — 별도 cleanup commit (#6 backlog).

---

## 결정 매트릭스

| PR | 변경 비용 | 영향 | 위험 | priority | 차단 요소 |
|---|---|---|---|---|---|
| PR-0 BLOCKER fix | 매우 낮 | 프로덕션 500 차단 | 매우 낮 | **P0** | 없음 |
| PR-1 prefix 재설계 | 중 | lifecycle/audit/cost 통제 가능 | 중 (write-side cutover) | P1 | PR-0 |
| PR-2 프론트 깨짐 + SAFE quick wins | 중 | 분리 배포 가능 | 중 (frontend+backend 동시 변경) | P1 | PR-1 |
| PR-3 분리 배포 검증 + 잔재 | 낮 | 잔존 기술 부채 정리 | 낮 | P2 | PR-2 |

---

## 검증·테스트 계획

### 신규 테스트 (자동 채택)

- `tests/test_api_videos.py` — DELETE /api/videos/{task_id} S3 + LocalDisk 양 모드 (PR-0)
- `tests/test_storage_keys.py` — task_input_key / task_output_key / user_upload_key (PR-1)
- `tests/test_api_files_redirect.py` — `/api/files/<task-prefix>/...` presigned URL redirect 검증 (PR-1)
- `frontend/src/lib/__tests__/format.test.ts` — `outputsPathToUrl` 새 contract 단위 테스트 (PR-2)
- `frontend/src/wizard/__tests__/normalizers.test.ts` — `isServerAsset` storage_key 인정 (PR-2)
- e2e (Playwright) `tests/e2e/separated-deploy.spec.ts` — frontend `localhost:5556` + backend `localhost:8001` 풀 플로우 (PR-3)

### 회귀 가드

- 기존 `tests/test_storage_s3.py` 통과 유지
- `tests/test_api_composite_generate.py`, `tests/test_api_host_generate.py` 회귀 없음
- frontend `npm run check` (typecheck + lint + tests) 모든 PR에서 통과
- bundle size-limit 260 KB 안 넘음

---

## 마이그레이션 sequence (시간 축)

```
T+0:  PR-0 BLOCKER fix 머지 → 프로덕션 즉시 안전
T+1:  PR-1 prefix 재설계 머지 → 새 task부터 task_id 그룹 사용
      (옛 데이터는 dual-read로 계속 동작)
T+2:  PR-2 frontend 깨짐 + quick wins → 분리 배포 invariant 확보
T+3:  PR-3 정리 + 분리 배포 smoke test → 배포 가능 상태 도달
```

각 PR 머지 후 main 브랜치 상태에서 라이브 검증. T+1~T+3 사이에 단계별 롤백 가능성 유지.

---

---

## /autoplan Phase 1 — CEO Review

> Started: 2026-04-29T16:22Z. UI scope: yes (8 hits). DX scope: yes (23 hits).
> Mode: SELECTIVE EXPANSION (scope expansion 채택 시 blast radius 안에서, +1d 미만)

### Step 0A — 명시된 premise

이 plan이 가정하는 것들:
1. **분리 배포가 실제 목표** — 프론트엔드를 별도 호스트로 빌드/배포한다는 전제 (memory에 저장된 의도 + 사용자 직접 발화)
2. **task_id grouping이 옳은 prefix 구조** — lifecycle 정책 + audit + 다운로드 UX 관점에서 옵션 C 하이브리드가 정답
3. **audit 38건이 정확하고 완전** — research agent가 1회성 스캔으로 추출
4. **PR S3+ (C1-C13)는 backend 측 cutover만 끝났고, frontend는 dual-input contract로 호환 동작 중** — git log + 코드 확인됨
5. **현재 task_id가 step1 host generation 시점엔 없음** — 1.4 절에서 명시, draft task_id 또는 별도 처리 필요
6. **`bucket=ailab-demo, prefix=dev/soulx-flashtalk`은 dev 환경, prod에선 다른 prefix** — `S3_ENV_PREFIX` env로 분기

### Step 0B — Existing code leverage map

이미 존재하는 코드로 대체 가능한 sub-problems:
- prefix 추상화: `_upload_local_to_storage(local_path, bucket_subpath, *, with_sidecar)` 헬퍼가 이미 있음 → key 생성 규칙만 바꾸면 됨
- dual-input handling: `safe_input_value` + `_validate_and_resolve` 가 storage_key/path 양쪽 받음 (C9에서 도입)
- presigned URL: `media_store.url_for(key, expires_in, download_filename)` (C10) — Result 페이지 fetch 흐름 그대로 활용
- S3 Mock 테스트 인프라: `tests/conftest.py` 의 moto fixture (C4) — 신규 테스트도 같은 fixture 재사용
- `validate_key()`: storage_key 형식 검증 — task_id grouping 도입 시 그대로 유효 (prefix 가정 안 함)

### Step 0C — Dream state delta

```
CURRENT (post-PR S3+ cutover, pre-this-plan):
  - S3 cutover 작동 중, dual-input 호환 contract
  - outputs/ 평면, lifecycle 정책 적용 불가
  - delete_video는 production에서 500
  - 분리 배포 시 silently 깨지는 frontend code path 6건
  - LocalDisk 전용 코드 38건 잔존

THIS PLAN (4 PRs land):
  - delete_video safe
  - tasks/<task_id>/ + uploads/<user_id>/ 구조 (write-side)
  - lifecycle 정책 적용 가능 (인프라 IaC는 별도)
  - frontend 분리 배포 invariant 확보
  - SAFE_TO_REMOVE 6건 정리

12-MONTH IDEAL:
  - lifecycle 정책 IaC로 자동화 (Terraform/CloudFormation)
  - 옛 데이터 마이그레이션 스크립트 1회 실행 후 dual-read 제거
  - CDN (CloudFront) 도입으로 presigned URL 캐싱 + 거리 단축
  - 사용자 다운로드 = task ZIP 일괄 (`tasks/<task_id>/outputs/*` zip)
  - multi-region S3 (한국 사용자라면 ap-northeast-2 등)
```

이 plan이 12-month ideal에서 "cutover 완성 + 분리 가능 invariant 확보" 까지 도달. 나머지는 별도 lane (lifecycle IaC, CDN, multi-region).

### Step 0C-bis — Implementation alternatives table

| 옵션 | Effort (CC) | Risk | Pros | Cons |
|---|---|---|---|---|
| **C 하이브리드 (제안)** | ~3h | M | task 단위 audit + uploads 영구 보존 | task_id 도입 시점 검토 필요 (step1 generation pre-task_id) |
| A 평면 (kind-only) | ~2h | L | lifecycle 단순 | task 단위 묶음 불가, 사용자 다운로드 UX 약함 |
| B 순수 task_id | ~5h | H | 가장 깔끔한 audit | 동일 host 재사용 시 중복 업로드, 비용↑ |
| D 새 hybrid: `<kind>/<task_id>/<file>` | ~3.5h | M | kind+task 둘 다, lifecycle도 prefix 단위 가능 | 너무 깊은 nesting, 옵션 C와 비슷한 effort |

### Step 0D — Mode 선택: SELECTIVE EXPANSION

- 채택: PR-0 (BLOCKER), PR-1 (prefix 재설계), PR-2 (frontend break + SAFE quick wins), PR-3 (정리)
- 이관: 옛 데이터 마이그레이션, lifecycle IaC, CDN, multi-region (Out of scope 명시됨)
- 검토: codex/subagent 결과 반영 후 결정

### Step 0E — Temporal interrogation

- HOUR 1 (PR-0 머지): production 즉시 안전. delete_video 500 차단.
- HOUR 6 (PR-1 머지): 새 task부터 task_id 그룹. 기존 task는 dual-read.
- DAY 1 (PR-2 머지): 분리 배포 invariant 확보. frontend silent break 6건 fix.
- DAY 2 (PR-3 머지): 분리 배포 smoke test 통과. 잔재 정리.
- WEEK 1: lifecycle 정책 IaC 별도 lane 시작.
- MONTH 1: 옛 데이터 자연 만료 (lifecycle TTL).

### Step 0F — Mode confirmation

SELECTIVE EXPANSION 모드 유지. 채택된 4 PR + 명시된 Out of scope.

### Step 0.5 — Dual Voices (CEO)

#### CODEX SAYS (CEO — strategy challenge)

10건 strategic blind spots:
1. **38-finding audit가 unreviewable** — `audit-2026-04-29.md` 파일이 specs/에 없어서 38건 카운트가 검증 불가
2. **Separated deploy 주장 overstated** — `API_BASE` 사용 주장은 사실이지만 frontend가 storage_key 받아서 `/api/files/...` root-relative URL 만드는 패턴은 분리 배포에서 깨짐
3. **task_id grouping은 잘못된 object model** — step1 host (pre-task-id) + 업로드 endpoint + TTS preview + saved host 모두 task 외부. fake draft task or orphan 생김
4. **kind+task hybrid 평가 안 됨** — `videos/<task_id>/`, `audios/<task_id>/`, `images/<task_id>/` + `uploads/<user_id>/` 가 더 나음. lifecycle은 prefix 외 object tag로도 가능
5. **진짜 10x 문제는 S3 layout이 아닌 Asset contract** — backend 응답 = `{asset_id, kind, owner, storage_key, url, retention, provenance, task_id?}`. Frontend는 path 안 받음. PR-1+PR-2 collapse 가능
6. **Out-of-scope 항목이 stated goal undercut** — lifecycle IaC, CDN, migration이 빠진 채 prefix 재설계는 비즈니스 outcome deliver 안 함
7. **PR sequencing 잘못됨** — PR-2 (contract hardening)이 PR-1 (storage layout)보다 먼저여야. 안 그러면 새 prefix에 같은 frontend bug 잔존
8. **경쟁 리스크 부재** — 한국 AI shopping host 시장의 existential risk는 quality/latency/cost/voice 자연스러움/IP consent/커머스 채널 통합. S3 prefix elegance는 무관
9. **6개월 후 foolish look** — task-only storage tree는 campaigns/saved-hosts/brand-kits/product-catalogs/A/B variants/multi-video batches 가 들어오면 약함
10. **CEO-level call**: PR-0만 즉시. "S3 마이그레이션 완성"을 strategy 취급 그만. Asset/deploy contract 먼저 정의, separated-deploy CI 검증, retention tag, 그 후 prefix 결정.

#### CLAUDE SUBAGENT (CEO — strategic independence)

6 finding (worst first):
1. **CRITICAL — 분리 배포 prerequisite 비즈니스 case 부재** — plan 어디에도 "왜 분리?" 답 없음. PR-2/PR-3의 60% 가상 문제. 4 PR → 2 PR로 50% 시간 절약 가능
2. **HIGH — PR-1 line count underestimated** — 200줄이 아닌 600-900줄 추정. step1 host pre-task_id가 critical issue인데 plan에서 "검토 항목"으로 떠넘김. 1a/1b로 쪼개야
3. **HIGH — task_id grouping 6개월 후 후회** — 사용자가 "저장 안 한 host candidate" 다시 보고 싶어함. cross-task search 어려움. kind+task hybrid 진지 평가 필요
4. **HIGH — 38건 audit 무비판 수용** — NEEDS_VERIFICATION 24건이 P1 PR scope에 그대로. 별도 verification PR로 빼야
5. **MEDIUM — PR-0 idempotent delete 부재** — Mongo update 실패 → S3 orphan delete 시나리오 없음
6. **MEDIUM — 경쟁사 대비 기회비용** — 4-6주 인프라 폴리싱 vs saved-host 디자인 (memory APPROVED) 같은 사용자 차별화 lane이 wait

#### CEO Dual Voices — Consensus Table

| # | Dimension | Claude | Codex | Consensus |
|---|---|---|---|---|
| 1 | 분리 배포가 right problem? | NO | NO | **CONFIRMED — premise 의심** |
| 2 | task_id grouping이 right object model? | NO | NO | **CONFIRMED — kind+task hybrid 또는 asset contract 권장** |
| 3 | PR sequencing 합리? | NO (1a/1b 쪼갬) | NO (contract before storage) | **CONFIRMED — sequencing 변경 필요** |
| 4 | 38건 audit 신뢰 가능? | NO (24 unverified) | NO (audit 파일 부재) | **CONFIRMED — verification 필요** |
| 5 | 6개월 후 trajectory 건전? | NO | NO | **CONFIRMED — Asset contract reframing 권장** |
| 6 | 경쟁/시장 위험 커버? | NO (제품 차별화 trade-off) | NO (existential risk 다른 곳) | **CONFIRMED — 비즈니스 우선순위 재검토** |

**전체**: **6/6 CONFIRMED, 0 DISAGREE**. 둘 다 동일한 6 차원에서 plan에 반대.

#### USER CHALLENGES (둘 다 동의하는 user direction 변경 권유)

세 가지 user challenge — premise gate에서 surface:

**Challenge 1 — 분리 배포 비즈니스 case 미정**
- User said: "프론트가 배포되면 못쓰니까 LocalDisk 잔재 다 정리"
- Both models recommend: 분리 배포 비즈니스 metric (어떤 사용자/비즈니스가 좋아지는가?)을 답하기 전엔 PR-2/PR-3 hold
- Why: separated deploy 안 한다면 PR-2.2 (`/static` mount 제거), PR-3.3 (separated-deploy.spec.ts) 60% 작업이 가상 문제
- What context we might be missing: user 회사가 이미 분리 배포 일정을 잡았을 수 있음 (인프라 팀 결정, 보안/DLP 요구 등)
- If we're wrong, the cost is: 분리 배포가 곧 일어나는데 prereq 안 했다면 deploy 시점에 6 silent break + 38건 LocalDisk 잔재가 production에 떨어짐

**Challenge 2 — `task_id` 단순 grouping (옵션 C) → kind+task hybrid 또는 Asset contract 우선 검토**
- User said: "옵션 C 하이브리드 (`tasks/<task_id>/inputs/`, `tasks/<task_id>/outputs/`)"
- Both models recommend: kind+task hybrid (`videos/<task_id>/video.mp4`, `audios/<task_id>/audio.wav`, `images/<task_id>/...`) 또는 Asset contract reframing (모든 backend 응답을 `Asset {asset_id, kind, owner, storage_key, url, retention, provenance}` 객체로 통일)
- Why: lifecycle 정책은 prefix 외 object tag로도 가능. cross-kind search/CDN 캐시 정책이 kind별 prefix 분리 시 단순. 6개월 후 campaigns/brand kits/A-B variants 들어오면 task-only tree 깨짐. step1 host pre-task_id, saved host, TTS preview 등 task 외부 use case 다수
- What context we might be missing: 사용자 행동 데이터 (저장 안 한 host candidate를 며칠 뒤 다시 보는 비율) 부재
- If we're wrong, the cost is: 옵션 C 그대로 가면 6개월 후 prefix 재설계 PR-2탄. 두 번 하면 더 비싸다

**Challenge 3 — 4 PR 시퀀스 → PR-0만 즉시 + 나머지는 strategy gate 통과 후**
- User said: 4 PR 단계 분해 (PR-0 → PR-1 → PR-2 → PR-3)
- Both models recommend: PR-0 (BLOCKER) 즉시 ship. PR-1/2/3는 (a) "분리 배포 왜?" 답, (b) Asset contract 정의, (c) kind+task vs task-only 결정 후 재작성
- Why: 4-6주 인프라 폴리싱은 사용자가 0% 본다. 동시 사용자 차별화 lane (saved-host APPROVED, playlist active) 진척 wait
- What context we might be missing: user 회사 사정상 PoC 이후 정식 출시 일정이 임박했고 인프라 폴리싱이 prerequisite (관리자 승인 조건 등)
- If we're wrong, the cost is: PR-0만 ship 후 재계획 진입했는데 사실 일정 압박이 있어서 4 PR 다 빨리 끝내야 했다면, 재계획 cost (1주) + 시간 압박

---

### Premise Gate Outcome (2026-04-29T16:35Z)

**User decision**: **Option A — PR-0만 즉시 ship, PR-1/2/3 재계획**

**의미**:
- ✅ PR-0 (delete_video BLOCKER fix) 즉시 진행 — production 500 차단
- ⏸️ PR-1, PR-2, PR-3 hold — premise + 구조 재검토 후 재작성
- 🔄 다음 strategy session 필요:
  1. 분리 배포 비즈니스 case (언제, 왜, 어느 환경에)
  2. S3 prefix 구조 (옵션 C / kind+task hybrid / Asset contract 중)
  3. PR sequencing (storage layout vs contract hardening 우선순위)

**Autoplan workflow 종료**: Phase 2/3/3.5/4는 진행 안 함. 본질적으로 plan revision이 필요한 상태이므로 review pipeline 의미 없음. PR-0만 즉시 ship 후 재계획 단계로 이동.

**다음 액션**:
1. PR-0 작성 + 머지 (XS, ~30 lines + idempotent delete pattern 추가)
2. Strategy session — kind+task hybrid vs Asset contract reframing 결정
3. 재작성된 plan에 대해 /plan-eng-review 또는 /autoplan 재실행


