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

from typing import Annotated, Any, Literal, Optional, Union

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
    synthesized: bool = False


# ────────────────────────────────────────────────────────────────────
# Video history (/api/history)
# ────────────────────────────────────────────────────────────────────


class VideoHistoryItem(_ExtraAllowBase):
    """One row from `outputs/video_history.json` (see `add_to_history`)."""

    task_id: str
    timestamp: str
    script_text: Optional[str] = None
    host_image: Optional[str] = None
    audio_source: Optional[str] = None
    output_path: Optional[str] = None
    file_size: Optional[int] = None
    video_url: str
    generation_time: Optional[float] = None
    type: Optional[TaskType] = None


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


# ────────────────────────────────────────────────────────────────────
# Generation jobs (/api/jobs) — streaming-resume Phase A.
#
# Step 3 ships only kind="host"; step 4 expands HostJobRequestPayload into
# a discriminated union with composite. Keep `extra='forbid'` on the
# request schemas so a typo'd field (e.g., faceRefpath) fails validation
# instead of silently bypassing safe_upload_path.
# ────────────────────────────────────────────────────────────────────

JobKind = Literal["host", "composite"]
JobState = Literal["pending", "streaming", "ready", "failed", "cancelled"]


class HostJobInput(BaseModel):
    """Step 1 host-candidate generation parameters. Mirrors the
    /api/host/generate Form fields as JSON so the runner can replay them
    exactly. Path fields (faceRefPath, outfitRefPath, styleRefPath) are
    sanitized via utils.security.safe_upload_path before storage —
    eng-spec §8."""

    model_config = ConfigDict(extra='forbid')

    mode: str
    prompt: Optional[str] = None
    extraPrompt: Optional[str] = None
    negativePrompt: Optional[str] = None
    builder: Optional[dict[str, Any]] = None
    faceRefPath: Optional[str] = None
    outfitRefPath: Optional[str] = None
    styleRefPath: Optional[str] = None
    faceStrength: float = 0.7
    outfitStrength: float = 0.7
    outfitText: Optional[str] = None
    seeds: Optional[list[int]] = None
    imageSize: str = "1K"
    n: int = 4
    temperature: Optional[float] = None


class HostJobRequestPayload(BaseModel):
    """POST /api/jobs body for kind='host'."""

    model_config = ConfigDict(extra='forbid')

    kind: Literal["host"]
    input: HostJobInput


class CompositeJobInput(BaseModel):
    """Step 2 composite (host + products + background) generation
    parameters. Mirrors the /api/composite/generate Form fields. Path
    fields (hostImagePath, productImagePaths[], backgroundUploadPath) are
    sanitized via safe_upload_path before storage."""

    model_config = ConfigDict(extra='forbid')

    hostImagePath: str
    productImagePaths: list[str] = Field(default_factory=list)
    backgroundType: Literal["preset", "upload", "prompt"]
    backgroundPresetId: Optional[str] = None
    backgroundPresetLabel: Optional[str] = None
    backgroundUploadPath: Optional[str] = None
    backgroundPrompt: Optional[str] = None
    direction: str = ""
    shot: str = "bust"
    angle: str = "eye"
    n: int = 4
    rembg: bool = True
    temperature: Optional[float] = None
    seeds: Optional[list[int]] = None
    imageSize: str = "1K"


class CompositeJobRequestPayload(BaseModel):
    """POST /api/jobs body for kind='composite'."""

    model_config = ConfigDict(extra='forbid')

    kind: Literal["composite"]
    input: CompositeJobInput


# Discriminated union — FastAPI surfaces 422 with field-level errors when
# either the kind tag or any kind-specific field validation fails.
JobCreateRequestPayload = Annotated[
    Union[HostJobRequestPayload, CompositeJobRequestPayload],
    Field(discriminator="kind"),
]


class JobSnapshot(_ExtraAllowBase):
    """Public job shape — input_blob is intentionally excluded. Used by
    POST /api/jobs (response_model) and step 5's GET /api/jobs/:id."""

    id: str
    user_id: str
    kind: JobKind
    state: JobState
    variants: list[dict[str, Any]] = Field(default_factory=list)
    prev_selected_image_id: Optional[str] = None
    batch_id: Optional[str] = None
    error: Optional[str] = None
    input_hash: Optional[str] = None
    created_at: Optional[Any] = None
    updated_at: Optional[Any] = None
    heartbeat_at: Optional[Any] = None
