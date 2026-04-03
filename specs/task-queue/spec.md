# Task Queue System Specification

## 개요
동시에 여러 비디오 생성 요청이 들어올 때, 큐에 저장하고 순차적으로 처리하는 시스템.
서버 재시작 시에도 큐 정보가 유지되어 이어서 처리 가능.

## 요구사항

### 핵심 기능
1. **영속적 큐 저장**: JSON 파일 기반으로 큐 정보를 로컬에 저장
2. **순차 처리**: GPU 리소스 제한으로 한 번에 하나의 생성 작업만 실행
3. **서버 재시작 복구**: 서버 재시작 시 pending 상태의 작업을 자동으로 이어서 처리
4. **큐 상태 API**: 현재 실행 중인 작업, 대기 중인 작업 목록 조회
5. **프론트엔드 UI**: 큐 상태를 실시간으로 확인할 수 있는 UI

### API Endpoints

| Endpoint | Method | 설명 |
|----------|--------|------|
| `GET /api/queue` | GET | 큐 전체 상태 조회 (현재 실행 중 + 대기 중 + 최근 완료) |
| `DELETE /api/queue/{task_id}` | DELETE | 대기 중인 작업 취소 |

### 큐 항목 상태
- `pending`: 큐에서 대기 중
- `running`: 현재 실행 중
- `completed`: 완료됨
- `error`: 오류 발생
- `cancelled`: 사용자가 취소

### 큐 저장 파일 형식 (`outputs/task_queue.json`)
```json
{
  "queue": [
    {
      "task_id": "abc123",
      "type": "generate" | "conversation",
      "params": { ... },
      "status": "pending",
      "created_at": "2026-04-03T10:00:00",
      "started_at": null,
      "completed_at": null,
      "error": null
    }
  ]
}
```

### 프론트엔드 UI
- 헤더 영역에 큐 상태 배지 (대기 중 작업 수)
- 큐 패널: 현재 실행 중인 작업, 대기 중인 작업 목록
- 대기 중인 작업 취소 버튼
- 5초 간격 자동 갱신

## 제약사항
- GPU 메모리 제한으로 동시 실행 불가 → 반드시 순차 처리
- 큐 파일은 `outputs/task_queue.json`에 저장
- 기존 `pipeline_lock` 메커니즘과 통합
