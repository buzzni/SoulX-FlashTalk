# SoulX-FlashTalk: Local Disk → AWS S3 마이그레이션 플랜 v2.0

**상태**: 진행 중 (커밋 단위로 main 직접, PR 분할 없음)
**작성일**: 2026-04-29 (v2 — codex + Plan subagent 검토 통합)

v1 검토 결과 13 critical + 6 minor 함정 발견 (`specs/s3-migration/review-findings.md` 참고). v2는 그걸 다 반영해 커밋 순서/추상화/contract 변경을 재정의했다.

---

## 0. 컨텍스트

- **환경**: dev (PoC 고객사 데모 전달용). prod는 비-목표.
- **버킷**: `ailab-demo` (단일). prefix로 환경/프로젝트 분리.
- **자격증명**: `.env`의 `S3_ACCESS_KEY` / `S3_SECRET_KEY` (이미 발급 받음).
- **인프라 셋업**: CORS/lifecycle/policy는 데모 동작에 필수 X. `docs/s3-bucket-setup.md`로 분리해 인프라팀 요청 (선택).
- **단일 uvicorn worker 가정**: `task_queue.json`이 로컬 파일이라 multi-worker는 미지원. 데모는 `--workers 1`.

---

## 1. 결정사항 (확정)

| # | 항목 | 결정 |
|---|---|---|
| 1 | 환경 prefix | `dev` 한 가지. 코드는 prod도 받게 (`S3_ENV_PREFIX` env var) |
| 2 | 자격증명 | `.env` 키. boot 시 fail-fast (모든 환경 일관) |
| 3 | Legacy invariant | 새 row는 `video_path=None` 강제. `is_legacy` 필드 X. "path is not None == legacy" |
| 4 | examples/ 처리 | S3에 한 번 sync (배포 스크립트). CompositeMediaStore X |
| 5 | idle_cache | 로컬 ephemeral. S3 X |
| 6 | upload retry | boto3 standard 모드 `S3_MAX_RETRY_ATTEMPTS=3` 총 시도 (1 + 2 retries) + caller가 `generate_video_task` 에서 outer 1회 wrap → 최악 6회. inference 결과는 job_dir에 보존, ffprobe 무결성 검증 후 upload |
| 7 | feature flag | 없음. **마지막 단일 커밋에서 한 번에 cutover** (`media_store = S3MediaStore(...)`) |
| 8 | rollback | 없음. dev라 fix-forward |
| 9 | frontend | API contract 변경 (`storage_key` 필드 추가). 자동 redirect 따라감 |

---

## 2. 키 구조

```
ailab-demo/
  dev/soulx-flashtalk/
    uploads/<filename>                   # 사용자 업로드
    outputs/<filename>                   # 결과 mp4, TTS wav
    outputs/hosts/saved/<filename>       # 저장된 호스트
    outputs/composites/<filename>        # 배경 합성
    examples/<filename>                  # 시드 (sync 한 번)
```

DB의 `storage_key`는 `<bucket>/<rest>` 형식 그대로 (`outputs/...`). env+project prefix는 `S3MediaStore`가 런타임에 prepend.

---

## 3. MediaStore Protocol (확장)

```python
class MediaStore(Protocol):
    # v1에서 유지
    def save_bytes(self, kind: str, data: bytes, *, suffix="", basename=None) -> str: ...
    def save_path(self, kind: str, src: Path, *, basename=None) -> str: ...
    def delete(self, key: str) -> bool: ...

    # v2 신규/확장
    def upload(self, src: Path, key: str) -> None: ...
    def download_to(self, key: str, dst: Path) -> None: ...
    @contextmanager
    def open_local(self, key: str) -> Iterator[Path]: ...
    def url_for(self, key: str, *, expires_in: int = 3600,
                download_filename: str | None = None) -> str: ...
    def head(self, key: str) -> dict: ...        # Content-Length / ETag / LastModified
    def exists(self, key: str) -> bool: ...
    def list_prefix(self, prefix: str) -> list[dict]: ...

    # deprecated (cutover 전 호출자 정리)
    def local_path_for(self, key: str) -> Path: ...
    def key_from_path(self, abs_path) -> str: ...
```

### 3.1 `local_path_for()` 호출자 정리 매트릭스

| 호출자 | 처리 |
|---|---|
| `studio_host_repo._serialize` (`:62`) | `path` 필드 제거. `storage_key + url_for`만 응답 |
| `studio_saved_host_repo._public` (`:37`) | 동일 |
| `app.py:1769` (/api/videos) | `RedirectResponse(url_for(key))` |
| `app.py:2471` (/api/files) | 동일 (legacy fallback 내장) |
| `app.py:3111` (delete) | `media_store.delete(key)` |
| `key_from_path` 호출자 (`app.py:801, 2122`, `studio_host_repo:168`) | 제거. generator가 직접 key를 만듦 |

C2부터 `local_path_for()`/`key_from_path()`가 `DeprecationWarning`을 발신 → 호출자는 pytest output / grep / IDE 어디서든 노란불을 본다. cutover 전까지 매트릭스의 모든 항목이 zero가 되어야 함.

### 3.2 kind-based vs key-based 공존

`save_bytes(kind=...)` / `save_path(kind=...)`은 영구 유지 (S3 backend도 동일 시그니처 구현). 신규 코드는 key-based (`upload(src, key)`) 권장 — `_KIND_PATH` 라우팅을 거치지 않고 호출자가 key 모양을 통제할 수 있어 마이그레이션 범위가 줄어든다.

### 3.3 boto3 client 설정

```python
boto3.client("s3",
    region_name=config.S3_REGION,
    aws_access_key_id=config.S3_ACCESS_KEY,
    aws_secret_access_key=config.S3_SECRET_KEY,
    config=Config(
        signature_version="s3v4",                    # ap-northeast-2 강제 + 모든 모던 region 안전
        retries={"max_attempts": config.S3_MAX_RETRY_ATTEMPTS, "mode": "standard"},
        max_pool_connections=config.S3_MAX_POOL_CONNECTIONS,
        connect_timeout=config.S3_CONNECT_TIMEOUT,
        read_timeout=config.S3_READ_TIMEOUT,
    ),
)
```

`make_default_s3_store()`는 `S3_ACCESS_KEY` / `S3_SECRET_KEY` 빈 문자열이면 즉시 raise — boto3가 기본 credential chain (env vars / `~/.aws/credentials` / IAM role) 으로 silent fallback하면 fail-fast 정책이 무력해지므로 명시 가드.

---

## 4. 흐름 변경

### 4.1 업로드 (백엔드 프록시)
```
Client → multipart POST → FastAPI tempfile → magic-byte validate
  → media_store.upload(tmp, key="uploads/host_xxxx.png")
  → respond { storage_key, url, path: storage_key }   # path는 호환용
  → tempfile cleanup
```

### 4.2 다운로드 (presigned redirect)
- `GET /api/files/<key>` → `RedirectResponse(url_for(key, expires_in=1h), 302)`
- `GET /api/videos/{task_id}` → `RedirectResponse(url_for(key, expires_in=6h), 302)`
- `GET /api/videos/{task_id}?download=true` → `url_for(key, download_filename="video.mp4")` (S3 ResponseContentDisposition 서명에 박음)
- **HEAD 분기 명시**: `head_object()` 호출 → Content-Length/ETag 헤더만 응답 (RenderDashboard용)

### 4.3 GPU inference (download → process → upload → cleanup)

```python
job_dir = Path(tempfile.mkdtemp(prefix=f"job-{task_id}-", dir=config.TEMP_DIR))
try:
    with media_store.open_local(host_key) as host_path, \
         media_store.open_local(audio_key) as audio_path:

        out_local = job_dir / f"{task_id}.mp4"
        # _run_torchrun_inference / pipeline (자식 프로세스에 절대 path 전달)
        # ffmpeg merge: -movflags +faststart 추가 (byte-range seek 효율)

        # 무결성 검증 + retry 업로드
        _ffprobe_validate(out_local)
        for attempt in range(3):
            try:
                media_store.upload(out_local, f"outputs/{task_id}.mp4")
                break
            except Exception:
                if attempt == 2: raise

        update_db(task_id, video_storage_key=key, video_path=None)
finally:
    shutil.rmtree(job_dir, ignore_errors=True)
```

- ctx manager 범위가 자식 프로세스 종료 (`proc.wait()`) 까지 살아있어야 함.
- 중간 산출물 (TTS wav, FlashTalk chunk, `_temp.mp4`, idle_cache)은 모두 로컬 temp.

### 4.4 Frontend API contract 변경

| 변경 | 영향 파일 |
|---|---|
| 업로드 응답에 `storage_key` 추가 | `frontend/src/api/upload.ts:24-30` |
| generate body는 `*_path` 대신 `*_key` 받음 | `frontend/src/api/video.ts:52-63`, `voice.ts:110-117` |
| `/api/files/{key}` 호출 시 redirect 자동 처리 | `frontend/src/api/file.ts:64-79` |
| `outputsPathToUrl`은 storage_key 그대로 받음 | `frontend/src/lib/format.ts:40-52` |
| `safe_upload_path` → `validate_storage_key` | `utils/security.py:37` |

---

## 5. 영향 파일

### 신규 (4)
- `modules/storage_s3.py` — `S3MediaStore`
- `tests/test_storage_s3.py` — moto 기반
- `scripts/upload_examples_to_s3.py` — examples/ S3 sync 도구
- `docs/s3-bucket-setup.md` — 인프라팀 요청서 (선택)

### 수정 (~22)
- `modules/storage.py`, `config.py`, `requirements.txt`
- `app.py` (8곳: 5 upload + /api/files + /api/videos + /api/hosts + 2 generate_*_task)
- `modules/host_generator.py`, `composite_generator.py`, `elevenlabs_tts.py`
- `modules/conversation_generator.py`, `video_matting.py`, `multitalk_inference.py`
- `modules/repositories/studio_result_repo.py`, `studio_host_repo.py`, `studio_saved_host_repo.py`
- `utils/security.py`
- `tests/conftest.py`
- `frontend/src/api/{upload,video,voice,file}.ts`, `lib/format.ts`

---

## 6. 커밋 단위 (v2: 13개, 각 단독 통과 가능)

| # | 제목 | 검증 |
|---|---|---|
| **C1** | deps + config + .env.example | `import boto3` OK, 기존 테스트 통과, 동작 변경 0 |
| **C2** | MediaStore Protocol 확장 + LocalDisk 동등 구현 | open_local (race invariant docstring) / upload·download_to (atomic tempfile+os.replace) / head (weak ETag + tz-aware datetime) / exists (invalid key raises) / list_prefix (정렬·symlink 차단) / url_for(download_filename → query). `local_path_for`/`key_from_path` DeprecationWarning. Protocol 만족 테스트 포함 |
| **C3** | S3MediaStore 구현 + moto 테스트 | 두 클래스 공존. media_store 싱글톤은 여전히 LocalDisk |
| **C4** | conftest.py moto autouse fixture | mock_aws() activate + media_store monkeypatch helper. 기존 fixture는 LocalDisk 모드로 호환 |
| **C5** | upload 핸들러 dual-compatible | 응답에 `storage_key` 추가, `path`는 호환용 유지. tempfile + media_store.upload |
| **C6** | generators dual-compatible | host/composite/elevenlabs/conversation/video_matting/multitalk. ffmpeg `-movflags +faststart` 추가. metadata sidecar 같이 처리 |
| **C7** | generate_*_task download/upload 패턴 | with open_local + ctx 자식 종료까지. retry 3회. ffprobe 검증. job_dir cleanup |
| **C8** | repos: legacy invariant 강제 | `studio_result_repo.upsert`에 `video_storage_key` 강제 가드, `video_path=None`. studio_host_repo `_serialize`/`_public`에서 path 필드 제거 |
| **C9** | frontend contract 전환 | api/{upload,video,voice,file}.ts + lib/format.ts. utils/security.py를 storage_key 검증으로 교체 |
| **C10** | /api/files, /api/videos, /api/hosts → redirect + HEAD | 302 redirect (S3 presigned). HEAD는 head_object. `?download_filename=...` query를 핸들러가 받아: LocalDisk면 Content-Disposition 헤더 직접 박음, S3면 presigned URL의 ResponseContentDisposition으로 위임 |
| **C11** | task_id 인덱스 + plan v2 close-out | `studio_results.create_index([("task_id", 1)])`. TODOS 정리 |
| **C12** | examples/ S3 sync 스크립트 | scripts/upload_examples_to_s3.py + DEFAULT_HOST_IMAGE/AUDIO를 storage_key로 |
| **C13** | **CUTOVER** + docs | 사전 게이트 4개: ① `examples/` S3 sync 완료 (C12 산출물), ② `rg "local_path_for\(\|key_from_path\(" app.py modules` 결과 0 (C8/C9 산출물), ③ startup hook이 `media_store.s3.head_bucket(Bucket=...)` 으로 자격증명 + 버킷 가능여부 sanity 체크 (실패 시 fail-fast), ④ 위 모두 통과 후 `app.py` `@app.on_event("startup")` 안에서 `from modules.storage_s3 import make_default_s3_store; modules.storage.media_store = make_default_s3_store()` (모듈 top-level import는 circular import 위험). `docs/s3-bucket-setup.md` 인프라팀 요청서 |

각 커밋 전:
1. 변경 파일/줄 요약
2. 테스트 결과
3. 수동 검증 (해당 시)
4. commit message 초안
→ 사용자 OK 후 commit.

---

## 7. 비-목표

- prod 환경 셋업
- CloudFront / CDN
- Presigned PUT 클라이언트 직접 업로드
- 기존 `outputs/`, `uploads/` 로컬 데이터 마이그레이션
- Storage class 최적화 (Intelligent-Tiering)
- multi-uvicorn-worker 지원 (큐 persistence가 로컬 파일이라)
- DB schema에 `storage_backend` enum 추가
- 인프라 셋업 자동화 (수동 한 번)

---

## 8. 인프라팀 요청서 (선택, 데모 동작에 필수 X)

C13에서 `docs/s3-bucket-setup.md`로 작성. 핵심:

- **IAM**: `ailab-demo/dev/soulx-flashtalk/*`에 GetObject/PutObject/DeleteObject/AbortMultipartUpload + ListBucket(prefix-scoped)
- **CORS**: GET+HEAD, AllowedHeaders Range/If-Range, ExposeHeaders Content-Range/Content-Length/Accept-Ranges/ETag
- **Lifecycle**: AbortIncompleteMultipartUpload 1d, dev/* 30d delete
- **Bucket policy**: SecureTransport, public access block

CORS 누락 시: byte-range seek 깨짐 (영상 첫 재생만 가능). 데모 시 seek 안 쓰면 무관.
Lifecycle 누락 시: 비용 누적만, 동작 영향 X.
