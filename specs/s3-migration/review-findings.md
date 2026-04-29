# S3 마이그레이션 plan v1.0 — 검토 통합 (2026-04-29)

두 reviewer 결과:
- **Codex** (`gpt-5.2 high reasoning`, 38 tool uses, 3.2M tokens, 6분 30초)
- **Claude Code Plan subagent** (Sonnet 4.6, 백그라운드)

**결과의 강한 일치 = 신뢰도 높음.** 13개의 critical 함정 + 6개의 minor 누락 발견.

---

## 🔴 Critical (즉시 plan 수정)

### C1. 커밋 순서 잘못 — C4 위치
**둘 다 발견.**
- plan v1: C4에서 `media_store` 싱글톤을 S3로 교체 → C5/C6/C7가 generator/upload 핸들러 전환.
- 문제: C4 후 C5-C7 끝나기 전엔 시스템이 broken — generator가 여전히 `result.save(out_path)`로 로컬 디스크에 쓰는데 `studio_saved_host_repo._public()`가 S3 presigned URL을 만듦. 200 OK + broken image. healthz 통과해서 알아채기 어려움.
- **수정**: C4를 "S3MediaStore 클래스 정의만, 싱글톤 교체 X"로. 실제 cutover는 C8 또는 별도 마지막 커밋(`media_store = S3MediaStore(...)` 한 줄)으로 미룸. 사이 모든 커밋은 LocalDisk와 양쪽 호환.

### C2. Legacy row fallback 우선순위가 거꾸로
**둘 다 발견.**
- 현재 코드 `app.py:1762-1774`: `video_path` 우선 → `video_storage_key` fallback (legacy 가정).
- plan v1: `video_storage_key` 우선 → `video_path` fallback (S3 가정).
- 문제: cutover 후 새 row도 manifest에 둘 다 채울 수 있음(`app.py:812`). mixed state — `video_storage_key` 있는데 그건 S3에 아직 없는 row를 redirect하면 깨짐.
- **수정**: 새 row invariant를 강제 — `app.py:798-812`에서 cutover 후 `video_path = None`. `studio_result_repo.upsert()`에 "completed인데 video_storage_key None이면 reject" 가드. 분기는 `try: redirect; except: fallback`.

### C3. `local_path_for()` deprecate가 8곳 영향
**둘 다 발견.** plan v1은 "legacy /api/files만 잠시 유지"라 적었지만:
- `studio_host_repo._serialize` (`modules/repositories/studio_host_repo.py:62`) — 매 직렬화마다 호출. saved host 50개 = 50번 S3 GET 위험.
- `studio_saved_host_repo._public` (`:37`)
- `app.py:1769` (`/api/videos`)
- `app.py:2471` (`/api/files`)
- `app.py:3111` (delete)
- `key_from_path()` 호출자: `app.py:801, 2122`, `studio_host_repo.py:168`
- **수정**: plan §4.1에 "8개 호출자 전환 매트릭스"를 명시. `_serialize/_public`은 `path` 필드 빼고 `storage_key + url`만 반환. `key_from_path`는 cutover 후 호출 안 됨 (generator가 직접 key를 만듦).

### C4. HEAD 메서드 처리 누락
**둘 다 발견.**
- `frontend/src/api/file.ts:64-79`가 `/api/videos/{task_id}` HEAD로 Content-Length 조회. RenderDashboard에서 사용.
- 302 redirect 응답엔 Content-Length 없음.
- **수정**: HEAD 분기 추가 — `s3.head_object()`로 Content-Length/ETag 응답. CORS `AllowedMethods`에 `HEAD` 추가.

### C5. Download 모드 — `Content-Disposition` 누락
**둘 다 발견.**
- `?download=true` 시 현재 `app.py:1751-1756`가 헤더 직접 설정.
- presigned URL redirect 후엔 헤더가 사라짐.
- **수정**: presigned URL 생성 시 `ResponseContentDisposition='attachment; filename="..."'` 파라미터 추가. `MediaStore.url_for(key, *, expires_in, download_filename=None)` 시그니처 확장.

### C6. Frontend API contract 변경 — "프론트 변경 없음"은 거짓
**둘 다 발견.**
- `frontend/src/api/upload.ts:24-30`이 업로드 응답의 `path` 필드를 generate body로 다시 보냄. `frontend/src/api/video.ts:52-63`도 동일. `voice.ts:110-117`도.
- cutover 후 path는 절대경로가 아니라 storage_key. `safe_upload_path()` 가드(`utils/security.py:37`)는 절대경로 가정 → 깨짐.
- **수정**: 모든 업로드 응답에 `storage_key` 필드 추가. generate 핸들러는 `host_image_path` 대신 `host_image_key` 받음. `safe_upload_path` → storage_key 검증으로 교체. **frontend/src/api/{upload,video,voice,file}.ts 모두 수정** — plan §6에 추가.

### C7. `_run_torchrun_inference` subprocess 경로
**둘 다 발견.**
- 자식 프로세스(`scripts/run_inference_subprocess.py`)는 `--image_path`, `--audio_path`, `--save_path`로 절대경로만 받음. boto3 모름.
- ctx manager가 자식 종료(`proc.wait()`) 후까지 살아있어야 cleanup이 자식이 파일 읽는 도중에 안 일어남.
- **수정**: plan §5.3의 `with media_store.open_local(...) as host_path:` 블록이 `_run_torchrun_inference` 전체를 감싸야 함. job_dir 안에 host/audio/result 모두 두기. 자식엔 절대경로 그대로.

### C8. Boot fail-fast → CI 죽음
**둘 다 발견.**
- moto fixture는 `boto3.client` 만들기 전에 `mock_aws()` context 활성화 필요. boot 시 fail-fast로 실제 AWS 호출하면 CI 환경(자격증명 없음)에서 모든 테스트 죽음.
- **수정**: hybrid — credential 존재만 빠르게 검사 (빈 문자열 아닌지). `s3.head_bucket` 같은 실제 호출은 첫 사용 시점으로 lazy. CI는 `pytest.fixture(autouse=True)`로 `mock_aws()` activate + `media_store`를 moto-backed로 monkeypatch. `dev` 환경에서 자격증명 누락 시 LocalDisk fallback + 큰 경고 로그(prod env에선 fail).

### C9. Upload retry — 5분 GPU 작업 후 1번 실패
**둘 다 발견.**
- `_worker_loop`(`task_queue.py:329-337`)는 예외 1번에 task error 처리. 사용자 재시도 = GPU 처음부터 다시.
- boto3 retry 5회는 PUT 자체만 재시도, multipart 부분 업로드 후 connection drop은 처음부터.
- **수정**: inference 결과 mp4를 임시로 보존(`upload_failed` 상태) → 별도 worker 또는 재시도 API. `try/except S3` 안에 `for attempt in range(3): ...` 명시. ffprobe로 무결성 검증 후 upload.

### C10. boto3 connection pool 부족
**Codex 발견.** 기본 `max_pool_connections=10`. 동시 5개 업로드 + GPU 다운로드 → 고갈 가능.
- **수정**: `Config(max_pool_connections=50, ...)` 추가.

### C11. `examples/` 시드 자산 fallback
**둘 다 발견.**
- `config.DEFAULT_HOST_IMAGE` (`config.py:151`)가 `examples/woman.png` 절대경로.
- S3-only `open_local("examples/woman.png")`로 바꾸면 S3에 없어서 깨짐.
- **수정**: `CompositeMediaStore` — `examples/*` → LocalDisk, `uploads|outputs/*` → S3. 또는 `_KIND_PATH["examples"]` 분기에서 LocalDisk fallback. 코드 배포에 examples/ 포함 그대로.

### C12. Multipart lifecycle 7일 너무 김 + abort 처리
**둘 다 발견.**
- plan v1: `AbortIncompleteMultipartUpload: 7 days` — 비용 누수 7일 방치.
- 프로세스 SIGKILL 시 finally 미실행. 같은 key에 multiple incomplete multipart 누적 가능.
- **수정**: lifecycle을 1일로 줄임. startup hook에 `list_multipart_uploads()`로 mount된 server의 stale 정리.

### C13. `task_id` index 없음
**Codex 발견.** `studio_results.find_by_task_id()` (`modules/repositories/studio_result_repo.py:246`) — 데이터 커지면 collection scan.
- **수정**: `studio_results.create_index([("task_id", 1)])` 추가. 별도 커밋.

---

## 🟡 Minor / 누락

### M1. ffmpeg `-movflags +faststart` 누락
**Codex 발견.** mp4 moov atom이 뒤에 있으면 byte-range seek가 더 많은 range 요청 유발.
- **수정**: `app.py:761-765`, `modules/conversation_generator.py:147`, `modules/multitalk_inference.py:464` ffmpeg 명령에 `-movflags +faststart` 추가.

### M2. `IDLE_CACHE_DIR` (`conversation_generator.py:18`) 정책 미정
**CC 발견.** content-hash 기반 디스크 캐시. cutover 후 TEMP_DIR은 임시라 캐시 hit 떨어짐.
- **수정**: idle video를 `outputs/idle_cache/<hash>.mp4`로 두고 S3 업로드 (재사용 의미 있음). 또는 ephemeral 명시 처리.

### M3. Metadata sidecar (`*.metadata.json`)
**CC 발견.** `host_generator.py:512`가 host png 옆에 `.metadata.json` 작성. plan §6 generator 전환에 sidecar 처리 누락.
- **수정**: sidecar도 같이 S3 upload. provenance 추적 보존.

### M4. `task_queue.json` 자체가 outputs/ 로컬
**둘 다 발견.** 큐 persistence는 plan 영향 밖이지만, multi-instance 시 깨짐. plan §1.3에 "single-uvicorn-worker assumption" 명시.

### M5. `app.mount("/static", ...)` UPLOADS_DIR
**CC 발견.** `app.py:88`. 사용처 확인 후 처리.

### M6. `studio_007_local_import` 마이그레이션 도구
**CC 발견.** 로컬 → DB 시드 도구. S3 환경에서 의미 변질. plan에 "이 코드 경로는 cutover 후 dead"인지 명시.

---

## ⚖️ Open Q 답변 (둘 다 동의)

| Q | 답 |
|---|---|
| Q1 legacy 식별 | `is_legacy` 필드 X. `video_path=None` 강제로 자연 식별 (path is not None == legacy) |
| Q2 examples/ | 코드 배포에 포함 + LocalDisk fallback. `CompositeMediaStore` 라우팅 |
| Q3 boot fail-fast | hybrid — prod fail / dev LocalDisk fallback / CI auto-mock |
| Q4 URL 캐싱 | 안 함. presigned는 stateless 유지 |
| Q5 재시작 | input normalization 필요 (legacy task가 절대경로 vs 새 task가 key) |
| Q6 fixture scope | function-scoped (격리 우선) |
| Q7 observability | `logger.exception(extra=...)` + boto3 client request_id 포함 |
| Q8 frontend 매트릭스 | 10 시나리오 (모바일 Safari + idle reload + 동시 다운로드 포함) |

---

## 사용자 제공 S3ObjectStorage 메서드 처리

**1단계 포함**: `upload`, `download_to`, `open_local`, `url_for`, `delete`, `head/exists`, `list_prefix` (마지막 두 개는 plan v1에 누락).

**1단계 제외 (별도 admin 모듈)**: `get_multipart_upload_urls_with_signed`, `change_prefix`, `copy_folder`, `put_object_from_url`, `put_object_tagging`, `put_bucket_life_cycle` (인프라 운영용), `put_json_string` (Mongo 사용).

`modules/storage_s3_admin.py`로 분리해 CLI 스크립트로만 호출.

---

## 결론

plan v1 그대로는 진행 불가. **plan v2.0으로 다시 작성 필요.** 주요 변화:
1. C4 분리 → cutover를 마지막 커밋으로
2. legacy fallback 우선순위 + invariant 강제
3. frontend API contract 변경 명시 (`storage_key` 필드, 핸들러 시그니처 변경)
4. `MediaStore` Protocol에 `head/exists`, `list_prefix` 추가
5. `safe_upload_path` → storage_key 검증으로 교체
6. boot fail-fast 정책을 hybrid로
7. upload 재시도 + 무결성 검증 + connection pool
8. CompositeMediaStore (examples/ 라우팅)
9. ffmpeg `-movflags +faststart`
10. `task_id` 인덱스 + lifecycle 1d
