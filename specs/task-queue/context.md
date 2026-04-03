# Task Queue - Implementation Context

## 현재 구조
- `app.py`에서 FastAPI `BackgroundTasks`를 사용하여 비디오 생성 작업 실행
- `pipeline_lock` (asyncio.Lock)으로 동시 실행 방지 → 하지만 여러 요청이 lock 대기 중일 때 순서 보장 안 됨
- `task_states` 딕셔너리로 작업 진행 상태 추적 (메모리 only, 서버 재시작 시 소실)

## 문제점
1. 서버 재시작 시 대기 중인 작업 정보가 모두 소실
2. 큐에 어떤 작업이 대기 중인지 확인할 방법 없음
3. 대기 중인 작업을 취소할 수 없음
4. lock 대기 중인 작업의 실행 순서가 보장되지 않음

## 수정 대상 파일
- `app.py`: 생성 엔드포인트에서 BackgroundTasks 대신 큐 시스템 사용
- `modules/task_queue.py`: 새로 생성 - 영속적 큐 관리 모듈
- `frontend/src/components/QueueStatus.jsx`: 새로 생성 - 큐 상태 UI 컴포넌트
- `frontend/src/App.jsx`: QueueStatus 컴포넌트 추가

## 기존 코드 영향
- `/api/generate` 엔드포인트: BackgroundTasks → 큐에 추가로 변경
- `/api/generate-conversation` 엔드포인트: BackgroundTasks → 큐에 추가로 변경
- `generate_video_task()`: 큐 워커에서 호출하도록 변경
- `generate_conversation_task()`: 큐 워커에서 호출하도록 변경
- `startup_event()`: 큐 워커 시작 + 미완료 작업 복구 로직 추가
