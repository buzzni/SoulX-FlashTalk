# Task Queue - Implementation Plan

## Phase 1: 큐 모듈 구현
- [x] `modules/task_queue.py` 생성
  - JSON 파일 기반 영속적 큐
  - `enqueue()`: 작업 추가
  - `dequeue()`: 다음 작업 가져오기
  - `update_status()`: 상태 업데이트
  - `get_queue_status()`: 전체 상태 조회
  - `cancel_task()`: 대기 중 작업 취소
  - `recover_interrupted()`: 서버 재시작 시 running → pending 복구
  - 큐 워커: asyncio 루프에서 pending 작업을 순차 실행

## Phase 2: 백엔드 통합
- [x] `app.py` 수정
  - `/api/generate`: BackgroundTasks 대신 큐에 enqueue
  - `/api/generate-conversation`: BackgroundTasks 대신 큐에 enqueue
  - `startup_event()`: 큐 워커 시작 + 중단된 작업 복구
  - `GET /api/queue`: 큐 상태 조회 API
  - `DELETE /api/queue/{task_id}`: 작업 취소 API

## Phase 3: 프론트엔드 UI
- [x] `QueueStatus.jsx` + `QueueStatus.css` 컴포넌트 생성
  - 큐 상태 배지 (대기 수)
  - 실행 중/대기 중 작업 목록
  - 취소 버튼
  - 5초 자동 갱신
- [x] `App.jsx`에 QueueStatus 추가

## 현재 상태: 구현 중
