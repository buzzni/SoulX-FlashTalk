"""
Pydantic response models for the frontend-consumed endpoints.

Purpose: make the FastAPI `/openapi.json` schema honest so
`openapi-typescript` on the frontend generates real types instead of
`Record<string, unknown>`. The endpoints themselves keep returning plain
`dict`s; FastAPI validates-and-serialises through these models when each
route declares `response_model=...`.

Scope: only the 5 endpoints the frontend reads today (see
frontend/REFACTOR_PLAN.md §Phase 0 / Decision #3). Admin/internal
endpoints stay untyped until someone actually consumes them from a
typed client.

Shape discipline:
- Field order mirrors the dict literals that live in `app.py` and
  `modules/task_queue.py` — easier to eyeball for drift.
- Every optional field in the current return bodies is `X | None` (with
  a default of `None`) so the generated TypeScript produces
  `field?: X | null`, matching the permissive reality of the current
  JSON payloads.
- No `Extra.forbid` — keep accepting dictionary entries the backend may
  add in the future so a frontend type-regen doesn't block a backend
  hotfix.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class _ExtraAllowBase(BaseModel):
    """Base model for response shapes.

    `extra='allow'` so fields the backend adds later pass through to the
    frontend unchanged, even before `modules/schemas.py` gets updated.
    Without this, FastAPI's `response_model` would silently *strip*
    any undeclared key before it reaches the client — so a backend
    change that adds `gpu_id` to the manifest would be invisible on
    the frontend side, and `openapi-typescript` would regenerate
    types that confirm the lie. `extra='allow'` means undeclared
    keys keep their values and appear in the serialised output.

    Declared fields still get type validation on the way out — this
    only affects undeclared ones.
    """

    model_config = ConfigDict(extra='allow')


# ────────────────────────────────────────────────────────────────────
# Queue (/api/queue)
# ────────────────────────────────────────────────────────────────────

TaskType = Literal["generate", "conversation"]
TaskStatus = Literal["pending", "running", "completed", "error", "cancelled"]


class QueueEntry(_ExtraAllowBase):
    """One task row as persisted by `TaskQueue` (see modules/task_queue.py).

    `params` is intentionally typed as an arbitrary dict because its
    shape varies by `type` (generate vs conversation) and also carries
    the client `meta` snapshot. Frontend consumers cherry-pick the
    fields they need.
    """

    task_id: str
    type: TaskType
    label: str = ""
    status: TaskStatus
    created_at: str
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    error: Optional[str] = None
    params: Optional[dict[str, Any]] = None


class QueueSnapshot(_ExtraAllowBase):
    """Return shape of `/api/queue` — matches `TaskQueue.get_status()`."""

    running: list[QueueEntry] = Field(default_factory=list)
    pending: list[QueueEntry] = Field(default_factory=list)
    recent: list[QueueEntry] = Field(default_factory=list)
    total_running: int = 0
    total_pending: int = 0


# ────────────────────────────────────────────────────────────────────
# Task state (/api/tasks/{task_id}/state)
# ────────────────────────────────────────────────────────────────────

# Stage keys the worker emits (see update_task call sites in app.py +
# modules/conversation_generator.py). Kept as a str rather than a Literal
# union so a new stage on the backend doesn't force an OpenAPI schema
# break — frontend resolves unknown stages to "loading" via the progress-%
# fallback in RenderDashboard/resolveStageIdx.
TaskStage = str


class TaskStateSnapshot(_ExtraAllowBase):
    """Polling-friendly snapshot of in-memory `task_states[task_id]`.

    Returned by `/api/tasks/{task_id}/state` — the polling path that
    replaces EventSource in client environments that block SSE.
    """

    task_id: str
    stage: Optional[TaskStage] = None
    progress: Optional[float] = None
    message: Optional[str] = None
    error: Optional[str] = None
    output_path: Optional[str] = None


# ────────────────────────────────────────────────────────────────────
# Result manifest (/api/results/{task_id})
# ────────────────────────────────────────────────────────────────────


class ResultParams(_ExtraAllowBase):
    """Subset of the dispatch params captured on the result manifest.

    See `_write_result_manifest` and `_synthesize_result_from_queue` in
    app.py for the source of each field. All optional because synthesized
    manifests (pre-manifest completions) may not have every field.
    """

    host_image: Optional[str] = None
    audio_path: Optional[str] = None
    audio_source_label: Optional[str] = None
    prompt: Optional[str] = None
    seed: Optional[int] = None
    cpu_offload: Optional[bool] = None
    script_text: Optional[str] = None
    resolution_requested: Optional[str] = None
    resolution_actual: Optional[str] = None
    scene_prompt: Optional[str] = None
    reference_image_paths: Optional[list[str]] = None


class ResultManifest(_ExtraAllowBase):
    """Return shape of `/api/results/{task_id}`.

    Written to `outputs/results/{task_id}.json` by
    `_write_result_manifest` on successful render; also constructed on
    the fly by `_synthesize_result_from_queue` for pre-manifest tasks.
    `synthesized: true` flags the fallback path.

    `meta` is the client snapshot (wizard state summary) attached at
    dispatch — arbitrary dict because it's opaque to the backend.
    """

    task_id: str
    type: TaskType = "generate"
    status: Literal["completed", "error", "cancelled"] = "completed"
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    generation_time_sec: Optional[float] = None
    video_url: str
    video_path: Optional[str] = None
    video_bytes: int = 0
    video_filename: Optional[str] = None
    params: ResultParams = Field(default_factory=ResultParams)
    meta: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    # eng-review 1A — D3A retry-aware primary depends on this field. The
    # frontend reads it to decide between 재시도 (retried_from=null) and
    # 수정해서 다시 만들기 (retried_from non-null) on the result page.
    retried_from: Optional[str] = None
    synthesized: bool = False


# ────────────────────────────────────────────────────────────────────
# Video history (/api/history)
# ────────────────────────────────────────────────────────────────────


class VideoHistoryItem(_ExtraAllowBase):
    """One row in `/api/history.videos[]`.

    PR-results-overhaul (2026-04-28): added `status` and `public_error` so
    the library page can render failed/cancelled cards with status pills
    and Korean error tooltips. `script_text`/`host_image`/`audio_source`
    are kept for backward compatibility but the new SPA derives titles
    from `(task_id, type)` via `formatTaskTitle`.
    """

    task_id: str
    timestamp: Optional[str] = None
    type: Optional[TaskType] = None
    status: Optional[Literal["completed", "error", "cancelled"]] = None
    public_error: Optional[str] = None
    # eng-review 1A — D3A retry lineage. Carried in /api/history rows so a
    # follow-up phase can render "다시 만든 영상" badges in the grid; the
    # result page already reads it via /api/results/{id}.
    retried_from: Optional[str] = None
    script_text: Optional[str] = None
    host_image: Optional[str] = None
    audio_source: Optional[str] = None
    output_path: Optional[str] = None
    file_size: Optional[int] = None
    video_url: str
    generation_time: Optional[float] = None


class HistoryResponse(_ExtraAllowBase):
    """Return shape of `/api/history`."""

    total: int
    videos: list[VideoHistoryItem] = Field(default_factory=list)


# ────────────────────────────────────────────────────────────────────
# Generic acks (optional — keep untyped for now)
# ────────────────────────────────────────────────────────────────────

class SimpleMessage(_ExtraAllowBase):
    """Generic `{message, ...}` ack body used by cancel etc. Not wired yet —
    staged here so follow-up phases can decorate endpoints without a second
    schemas refactor."""

    message: str
    task_id: Optional[str] = None
