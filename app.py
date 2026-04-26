"""
FastAPI backend for SoulX-FlashTalk Video Generator
Provides REST API with SSE progress, file uploads, ElevenLabs TTS, and video generation.
"""

import os
import sys
import uuid
import asyncio
import logging
import json
import time
from pathlib import Path
from typing import Optional, List
from datetime import datetime

from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import uvicorn

import config
from modules import auth as auth_module
from modules import db as db_module
from modules.task_queue import task_queue
from modules.schemas import (
    HistoryResponse,
    QueueSnapshot,
    ResultManifest,
    TaskStateSnapshot,
)

# Setup logging
logging.basicConfig(
    level=getattr(logging, config.LOG_LEVEL),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# ========================================
# Global State
# ========================================
pipeline = None  # FlashTalk pipeline
multitalk_pipeline = None  # MultiTalk pipeline (separate weights)
active_pipeline_type = None  # "flashtalk" or "multitalk"
pipeline_lock = None
task_states = {}  # task_id -> {stage, progress, message, error, updates[]}

app = FastAPI(
    title="SoulX-FlashTalk Video Generator",
    description="Audio-driven avatar video generation with ElevenLabs TTS",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,  # Phase 0 D12: explicit list, not "*"
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Phase 0 §4.0.3/4.0.6/4.0.7 — request middleware stack
from utils.middleware import AuditLog, ApiKeyAuth, ContentLengthLimit

app.add_middleware(AuditLog)  # outermost (logs even on 4xx)
app.add_middleware(ApiKeyAuth)
app.add_middleware(ContentLengthLimit)


# Studio JWT auth (PR2). Goes inside CORS / AuditLog so 401s still get
# CORS headers and audit lines. The middleware is a no-op for paths in
# auth_module.PUBLIC_PATHS / PUBLIC_PATH_PREFIXES.
@app.middleware("http")
async def _studio_auth(request, call_next):
    return await auth_module.auth_middleware(request, call_next)

# Create directories
for d in [config.UPLOADS_DIR, config.OUTPUTS_DIR, config.TEMP_DIR, config.EXAMPLES_DIR, config.HOSTS_DIR, config.RESULTS_DIR]:
    os.makedirs(d, exist_ok=True)

# Mount static files (UPLOADS only — NOT PROJECT_ROOT; Phase 0 Critical #1)
app.mount("/static", StaticFiles(directory=config.UPLOADS_DIR), name="static")


# ========================================
# Task Progress Tracking
# ========================================

def create_task(task_id: str):
    task_states[task_id] = {
        "stage": "idle",
        "progress": 0.0,
        "message": "대기 중...",
        "error": None,
        "updates": [],
        "output_path": None,
    }


def update_task(task_id: str, stage: str, progress: float, message: str):
    if task_id not in task_states:
        return
    state = task_states[task_id]
    state["stage"] = stage
    state["progress"] = progress
    state["message"] = message
    state["updates"].append({
        "stage": stage,
        "progress": progress,
        "message": message,
        "timestamp": datetime.now().isoformat(),
    })


def _snap_resolution_to_16(target_h: int, target_w: int) -> tuple[int, int]:
    """Snap a (height, width) pair down to the nearest multiple of 16.

    FlashTalk's WAN backbone uses VAE stride 8 × patch_size (2, 2) in spatial
    dims, so both axes must be divisible by 16 — otherwise the latent grid has
    a non-integer half on one side and attention fails with
      "The size of tensor a (N) must match the size of tensor b (M) at ..."
    (see 2026-04-23 tasks 63aad9a2 / 3b11e977: 1920×1080 → 1080/16=67.5 → crash.)

    Floor rather than round so we never upscale past the user's pick; worst
    case the output loses ≤15px on an axis, which is imperceptible vs. hard
    crash. Preset 1920×1080 → 1920×1072 here.
    """
    snap = lambda v: max(16, (v // 16) * 16)
    return snap(target_h), snap(target_w)


def _validate_image_size(raw: Optional[str]) -> str:
    """Gemini 3.1 flash-image-preview accepts 1K / 2K / 4K (verified live
    2026-04-23). Actual pixel counts at 9:16:
      1K → 768×1376 (~1.4MP)
      2K → 1536×2752 (~4.2MP)
      4K → 3072×5504 (~17MP, ~4× time and ~15-30MB PNGs)
    Reject anything else up front so users get a clear 400 instead of
    the Gemini API's "Request contains an invalid argument." blob.
    """
    normalized = (raw or "1K").strip().upper()
    if normalized not in {"1K", "2K", "4K"}:
        raise HTTPException(
            status_code=400,
            detail=f"imageSize must be '1K', '2K', or '4K', got {raw!r}"
        )
    return normalized


def _parse_seeds_form(raw: Optional[str]) -> Optional[List[int]]:
    """Parse the `seeds` form field (JSON array of ints) or return None.

    Rejects malformed JSON / non-int elements with 400 — it's cheaper to
    fail fast than to let the Gemini client blow up mid-generation.
    """
    if not raw:
        return None
    try:
        data = json.loads(raw)
        if not isinstance(data, list):
            raise ValueError("seeds must be a JSON array")
        return [int(x) for x in data]
    except (json.JSONDecodeError, ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid seeds: {e}")


def _build_queue_label(
    explicit: Optional[str],
    script_text: Optional[str],
    resolution: Optional[str],
    host_image_path: Optional[str],
) -> str:
    """Compose a meaningful queue label.

    Priority: client-supplied > script preview > resolution + host filename
    > generic fallback. Caps at 80 chars so the queue UI doesn't wrap.
    Previously every job displayed "Video generation" because the frontend
    didn't pass script_text on /api/generate, leaving the original fallback
    as the only label users ever saw.
    """
    if explicit and explicit.strip():
        return explicit.strip()[:80]
    if script_text and script_text.strip():
        clean = " ".join(script_text.split())
        return clean[:80]
    parts = []
    if resolution:
        parts.append(resolution.replace("x", "×"))
    if host_image_path:
        parts.append(os.path.basename(host_image_path))
    return " · ".join(parts) if parts else "쇼호스트 영상"


def set_task_error(task_id: str, error: str):
    if task_id not in task_states:
        return
    state = task_states[task_id]
    state["stage"] = "error"
    state["error"] = error
    state["updates"].append({
        "stage": "error",
        "progress": state["progress"],
        "message": error,
        "timestamp": datetime.now().isoformat(),
    })


# ========================================
# Helper
# ========================================

def save_upload_file(upload_file: UploadFile, destination: str, max_bytes: int | None = None) -> str:
    """Stream-save upload with cumulative size cap (Phase 0 CSO High #6).

    Defaults to config.MAX_UPLOAD_BYTES. Aborts mid-stream with 413 if exceeded.
    """
    if max_bytes is None:
        max_bytes = config.MAX_UPLOAD_BYTES
    chunk_size = 1024 * 1024  # 1MB
    total = 0
    try:
        with open(destination, "wb") as f:
            while True:
                chunk = upload_file.file.read(chunk_size)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    f.close()
                    try:
                        os.unlink(destination)
                    except OSError:
                        pass
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds {max_bytes // 1_000_000}MB limit",
                    )
                f.write(chunk)
        return destination
    finally:
        upload_file.file.close()


# ========================================
# Pipeline Management
# ========================================

def _unload_pipeline(pipeline_type: str):
    """Unload a pipeline to free GPU/CPU memory."""
    global pipeline, multitalk_pipeline, active_pipeline_type
    import torch
    import gc

    if pipeline_type == "flashtalk" and pipeline is not None:
        logger.info("Unloading FlashTalk pipeline...")
        del pipeline
        pipeline = None
    elif pipeline_type == "multitalk" and multitalk_pipeline is not None:
        logger.info("Unloading MultiTalk pipeline...")
        del multitalk_pipeline
        multitalk_pipeline = None

    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    active_pipeline_type = None


def _ensure_flashtalk_pipeline(cpu_offload: bool):
    """Load FlashTalk pipeline, unloading MultiTalk if needed."""
    global pipeline, active_pipeline_type
    if pipeline is not None:
        return

    # Unload MultiTalk first to free memory
    if multitalk_pipeline is not None:
        _unload_pipeline("multitalk")

    from flash_talk.inference import get_pipeline
    logger.info("Loading FlashTalk pipeline...")
    pipeline = get_pipeline(
        world_size=1,
        ckpt_dir=config.FLASHTALK_CKPT_DIR,
        wav2vec_dir=config.FLASHTALK_WAV2VEC_DIR,
        cpu_offload=cpu_offload,
    )
    active_pipeline_type = "flashtalk"
    logger.info("FlashTalk pipeline loaded successfully")


def _ensure_multitalk_pipeline(cpu_offload: bool):
    """Load MultiTalk pipeline, unloading FlashTalk if needed."""
    global multitalk_pipeline, active_pipeline_type
    if multitalk_pipeline is not None:
        return

    # Unload FlashTalk first to free memory
    if pipeline is not None:
        _unload_pipeline("flashtalk")

    from modules.multitalk_inference import get_multitalk_pipeline
    multitalk_pipeline = get_multitalk_pipeline(
        ckpt_dir=config.MULTITALK_CKPT_DIR,
        wav2vec_dir=config.FLASHTALK_WAV2VEC_DIR,
        cpu_offload=cpu_offload,
    )
    active_pipeline_type = "multitalk"


# ========================================
# Video Generation (async)
# ========================================

async def generate_video_task(
    task_id: str,
    host_image: str,
    audio_path: str,
    audio_source_label: str,
    prompt: str,
    seed: int,
    cpu_offload: bool,
    user_id: Optional[str] = None,
    script_text: str = "",
    resolution: str = "1280x720",
    scene_prompt: str = "",
    reference_image_paths: list = None,
    meta: Optional[dict] = None,
    playlist_id: Optional[str] = None,
):
    """Run SoulX-FlashTalk video generation in background"""
    global pipeline, pipeline_lock

    # `task_states` is in-memory (module-level dict) and is wiped on backend
    # restart. The persisted queue survives the restart and `_recover_interrupted`
    # flips any in-flight entry back to "pending", so the worker picks it up
    # again here — but without a task_states row every update_task() call is a
    # silent no-op and the SSE endpoint returns 404. Initialize on pickup if
    # missing; keep the existing row (including prior "queued" update) when
    # the task was dispatched in this process lifetime.
    if task_id not in task_states:
        create_task(task_id)

    start_time = time.time()

    async with pipeline_lock:
        logger.info(f"Task {task_id} acquired lock, starting generation...")

        try:
            loop = asyncio.get_event_loop()

            # Stage 0: Gemini background generation (if scene_prompt provided)
            if scene_prompt and scene_prompt.strip():
                update_task(task_id, "compositing_bg", 0.02, "배경 생성 중 (Gemini)...")
                ref_paths = reference_image_paths or []

                res_parts = resolution.split("x")
                target_h, target_w = _snap_resolution_to_16(int(res_parts[0]), int(res_parts[1]))

                from modules.image_compositor import compose_agents_together, release_models

                try:
                    # compositor expects (width, height) — "1280x720" → h=1280, w=720 → pass (h, w) as (w, h)
                    results = await loop.run_in_executor(
                        None,
                        lambda: compose_agents_together(
                            host_image_paths=[host_image],
                            bg_image_path=os.path.join(config.UPLOADS_DIR, "dummy"),
                            target_size=(target_h, target_w),
                            layout="single",
                            scene_prompt=scene_prompt,
                            reference_image_paths=ref_paths if ref_paths else None,
                        )
                    )
                    # Use the composed image as the host image for FlashTalk
                    composed_path = results.get("full") or results.get(0)
                    if composed_path and os.path.exists(composed_path):
                        host_image = composed_path
                        logger.info(f"Gemini background applied: {composed_path}")
                    update_task(task_id, "compositing_bg", 0.08, "배경 생성 완료")
                finally:
                    await loop.run_in_executor(None, release_models)

            # Stage 1: Load pipeline if needed
            update_task(task_id, "loading", 0.1, "모델 로딩 중...")
            await loop.run_in_executor(None, lambda: _ensure_flashtalk_pipeline(cpu_offload))

            # Parse resolution (e.g., "1280x720" -> height=1280, width=720).
            # Snap to 16× — FlashTalk VAE(8) × patch(2) requires both axes be
            # multiples of 16 or attention dies with a shape mismatch.
            res_parts = resolution.split("x")
            raw_h, raw_w = int(res_parts[0]), int(res_parts[1])
            target_h, target_w = _snap_resolution_to_16(raw_h, raw_w)
            if (target_h, target_w) != (raw_h, raw_w):
                logger.info(f"Task {task_id}: snapped resolution {raw_w}x{raw_h} -> {target_w}x{target_h} (16× alignment)")
            update_task(task_id, "preparing", 0.2, f"데이터 준비 중... ({target_w}x{target_h})")

            # Stage 2: Prepare base data with custom resolution
            def prepare_data():
                from flash_talk.inference import infer_params
                from flash_talk.src.pipeline.flash_talk_pipeline import FlashTalkPipeline
                target_size = (target_h, target_w)
                pipeline.prepare_params(
                    input_prompt=prompt,
                    cond_image=host_image,
                    target_size=target_size,
                    frame_num=infer_params['frame_num'],
                    motion_frames_num=infer_params['motion_frames_num'],
                    sampling_steps=infer_params['sample_steps'],
                    seed=seed,
                    shift=infer_params['sample_shift'],
                    color_correction_strength=infer_params['color_correction_strength'],
                )

            await loop.run_in_executor(None, prepare_data)

            update_task(task_id, "generating", 0.3, "비디오 생성 중...")

            # Stage 3: Generate video chunks
            def run_generation():
                import numpy as np
                import librosa
                import torch
                from collections import deque
                from flash_talk.inference import get_audio_embedding, run_pipeline, infer_params

                sample_rate = infer_params['sample_rate']
                tgt_fps = infer_params['tgt_fps']
                cached_audio_duration = infer_params['cached_audio_duration']
                frame_num = infer_params['frame_num']
                motion_frames_num = infer_params['motion_frames_num']
                slice_len = frame_num - motion_frames_num

                human_speech_array_all, _ = librosa.load(audio_path, sr=sample_rate, mono=True)

                # Pre-attenuate to target LUFS. FlashTalk's internal
                audio_encode_mode = config.FLASHTALK_OPTIONS.get("audio_encode_mode", "stream")
                generated_list = []

                if audio_encode_mode == 'once':
                    human_speech_array_frame_num = frame_num * sample_rate // tgt_fps
                    human_speech_array_slice_len = slice_len * sample_rate // tgt_fps

                    remainder = (len(human_speech_array_all) - human_speech_array_frame_num) % human_speech_array_slice_len
                    if remainder > 0:
                        pad_length = human_speech_array_slice_len - remainder
                        human_speech_array_all = np.concatenate([human_speech_array_all, np.zeros(pad_length, dtype=human_speech_array_all.dtype)])

                    audio_embedding_all = get_audio_embedding(pipeline, human_speech_array_all)
                    chunks = [audio_embedding_all[:, i * slice_len: i * slice_len + frame_num].contiguous()
                              for i in range((audio_embedding_all.shape[1] - frame_num) // slice_len)]

                    total = len(chunks)
                    for idx, chunk in enumerate(chunks):
                        torch.cuda.synchronize()
                        video = run_pipeline(pipeline, chunk)
                        if idx != 0:
                            video = video[motion_frames_num:]
                        generated_list.append(video.cpu())
                        logger.info(f"Chunk {idx}/{total} done")
                        # Per-chunk progress: scale 0.3 → 0.9 linearly across chunks.
                        # Without this the UI freezes at 30% for the full inference
                        # window (~60-90s/chunk × 45 chunks = 45+ min for a typical
                        # script), making a healthy job look hung.
                        update_task(
                            task_id, "generating",
                            0.3 + 0.6 * (idx + 1) / total,
                            f"쇼호스트 움직임 만드는 중 ({idx + 1}/{total})",
                        )

                else:  # stream
                    human_speech_array_slice_len = slice_len * sample_rate // tgt_fps
                    cached_audio_length_sum = sample_rate * cached_audio_duration
                    audio_end_idx = cached_audio_duration * tgt_fps
                    audio_start_idx = audio_end_idx - frame_num

                    audio_dq = deque([0.0] * cached_audio_length_sum, maxlen=cached_audio_length_sum)

                    remainder = len(human_speech_array_all) % human_speech_array_slice_len
                    if remainder > 0:
                        pad_length = human_speech_array_slice_len - remainder
                        human_speech_array_all = np.concatenate([human_speech_array_all, np.zeros(pad_length, dtype=human_speech_array_all.dtype)])

                    slices = human_speech_array_all.reshape(-1, human_speech_array_slice_len)

                    total = len(slices)
                    for idx, audio_slice in enumerate(slices):
                        audio_dq.extend(audio_slice.tolist())
                        audio_array = np.array(audio_dq)
                        audio_embedding = get_audio_embedding(pipeline, audio_array, audio_start_idx, audio_end_idx)

                        torch.cuda.synchronize()
                        video = run_pipeline(pipeline, audio_embedding)
                        video = video[motion_frames_num:]
                        generated_list.append(video.cpu())
                        logger.info(f"Chunk {idx}/{total} done")
                        # Per-chunk progress (see 'once' branch above for rationale).
                        update_task(
                            task_id, "generating",
                            0.3 + 0.6 * (idx + 1) / total,
                            f"쇼호스트 움직임 만드는 중 ({idx + 1}/{total})",
                        )

                return generated_list, tgt_fps

            generated_list, tgt_fps = await loop.run_in_executor(None, run_generation)

            update_task(task_id, "saving", 0.9, "비디오 저장 중...")

            # Stage 4: Save video
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"res_{timestamp}_{task_id[:8]}.mp4"
            output_path = os.path.join(config.OUTPUTS_DIR, filename)

            def save_video():
                import imageio
                import numpy as np
                import subprocess

                temp_path = output_path.replace(".mp4", "_temp.mp4")
                with imageio.get_writer(temp_path, format='mp4', mode='I', fps=tgt_fps, codec='h264', ffmpeg_params=['-bf', '0']) as writer:
                    for frames in generated_list:
                        frames_np = frames.numpy().astype(np.uint8)
                        for i in range(frames_np.shape[0]):
                            writer.append_data(frames_np[i])

                cmd = ['ffmpeg', '-y', '-i', temp_path, '-i', audio_path, '-c:v', 'copy', '-c:a', 'aac', '-shortest', output_path]
                subprocess.run(cmd, check=True, capture_output=True)

                if os.path.exists(temp_path):
                    os.remove(temp_path)

            await loop.run_in_executor(None, save_video)

            # Record
            task_states[task_id]["output_path"] = output_path
            generation_time = time.time() - start_time

            # Result manifest — source of truth for the frontend /result/:taskId
            # page. Captures both sides: the backend payload actually used
            # (resolution AFTER 16× snap, file stats, seed, output path) AND
            # the client snapshot (`meta`) when one was attached at dispatch.
            # Persisted to studio_results (PR5; was outputs/results/<task>.json).
            video_bytes = os.path.getsize(output_path) if os.path.exists(output_path) else 0
            from modules import storage as _storage
            try:
                video_storage_key = _storage.media_store.key_from_path(output_path)
            except ValueError:
                video_storage_key = None
            manifest = {
                "task_id": task_id,
                "type": "generate",
                "status": "completed",
                "completed_at": datetime.now(),
                "generation_time_sec": round(generation_time, 2),
                "video_url": f"/api/videos/{task_id}",
                "video_storage_key": video_storage_key,
                "video_path": output_path,
                "video_bytes": video_bytes,
                "video_filename": os.path.basename(output_path),
                "params": {
                    "host_image": host_image,
                    "audio_path": audio_path,
                    "audio_source_label": audio_source_label,
                    "prompt": prompt,
                    "seed": seed,
                    "cpu_offload": cpu_offload,
                    "script_text": script_text,
                    "resolution_requested": resolution,
                    "resolution_actual": f"{target_h}x{target_w}",
                    "scene_prompt": scene_prompt,
                    "reference_image_paths": reference_image_paths or [],
                },
                "meta": meta,
                "playlist_id": playlist_id,
            }
            if user_id:
                try:
                    from modules.repositories import studio_result_repo as _result_repo
                    await _result_repo.upsert(user_id, manifest)
                except Exception as e:
                    # Never fail the task because the manifest write failed.
                    logger.warning(f"Task {task_id}: manifest upsert failed: {e}")
            else:
                logger.info(f"Task {task_id}: skipping manifest persist (no user_id)")

            # Lifecycle commit — promote each step's currently-selected
            # candidate to "committed" (linked to this video task_id) and
            # delete the surrounding draft / prev_selected siblings. No-op
            # if the user never marked a selection (commit returns None).
            # task_id IS the video_id (frontend uses /api/videos/{task_id}).
            if user_id:
                try:
                    from modules.repositories import studio_host_repo as host_repo
                    await host_repo.commit(user_id, "1-host", task_id)
                    await host_repo.commit(user_id, "2-composite", task_id)
                except Exception as le:
                    logger.warning(f"Task {task_id}: lifecycle commit failed: {le}")
            else:
                # Pre-PR2 task with no owner — nothing to attribute the
                # commit to. Skip; data integrity preserved by 007 import.
                logger.info(f"Task {task_id}: skipping lifecycle commit (no user_id)")

            update_task(task_id, "complete", 1.0, f"비디오 생성 완료! ({generation_time:.1f}초)")
            logger.info(f"Task {task_id} completed: {output_path}")

            # Clear GPU cache
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

        except Exception as e:
            logger.error(f"Task {task_id} failed: {e}")
            import traceback
            traceback.print_exc()
            set_task_error(task_id, f"비디오 생성 실패: {str(e)}")

            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

            # Re-raise so the queue worker's outer handler records status="error"
            # in task_queue.json. Without this, swallowed exceptions looked like
            # clean completions and the frontend rendered a success UI with
            # <video src="/api/videos/{id}"> that 404'd on the nonexistent file.
            raise


# ========================================
# Startup
# ========================================

@app.on_event("startup")
async def startup_event():
    global pipeline_lock
    pipeline_lock = asyncio.Lock()

    # Connect to MongoDB and ensure indexes exist before serving traffic.
    # Fail-fast: if mongod is unreachable, this raises and uvicorn won't bind
    # (per docs/db-integration-plan.md decision #15).
    await db_module.init()

    # Register queue handlers and start worker
    task_queue.register_handler("generate", _queue_generate_handler)
    task_queue.register_handler("conversation", _queue_conversation_handler)
    await task_queue.start()

    logger.info("SoulX-FlashTalk API server started (queue worker active)")


@app.on_event("shutdown")
async def shutdown_event():
    await db_module.close()


async def _queue_generate_handler(task_id: str, user_id: str, **params):
    """Queue handler that delegates to generate_video_task."""
    await generate_video_task(
        task_id=task_id,
        user_id=user_id,
        host_image=params["host_image"],
        audio_path=params["audio_path"],
        audio_source_label=params["audio_source_label"],
        prompt=params["prompt"],
        seed=params["seed"],
        cpu_offload=params["cpu_offload"],
        script_text=params.get("script_text", ""),
        resolution=params.get("resolution", "1280x720"),
        scene_prompt=params.get("scene_prompt", ""),
        reference_image_paths=params.get("reference_image_paths"),
        meta=params.get("meta"),
        playlist_id=params.get("playlist_id"),
    )


async def _queue_conversation_handler(task_id: str, user_id: str, **params):
    """Queue handler that delegates to generate_conversation_task."""
    await generate_conversation_task(
        task_id=task_id,
        user_id=user_id,
        dialog_data=params["dialog_data"],
        layout=params["layout"],
        prompt=params["prompt"],
        seed=params["seed"],
        cpu_offload=params["cpu_offload"],
        resolution=params.get("resolution", "1280x720"),
        playlist_id=params.get("playlist_id"),
    )


# ========================================
# API Endpoints
# ========================================

@app.get("/")
async def root():
    return {"message": "SoulX-FlashTalk Video Generator API", "version": "1.0.0"}


@app.get("/api/config")
async def get_config():
    return {
        "default_host_image_male": "examples/man_default.png",
        "default_host_image_female": "examples/woman.png",
        "default_audio": "examples/cantonese_16k.wav",
        "default_prompt": config.FLASHTALK_OPTIONS["default_prompt"],
        "default_seed": config.FLASHTALK_OPTIONS["base_seed"],
        "cpu_offload": config.FLASHTALK_OPTIONS["cpu_offload"],
        "audio_encode_mode": config.FLASHTALK_OPTIONS["audio_encode_mode"],
        "elevenlabs_configured": bool(config.ELEVENLABS_API_KEY),
        "elevenlabs_model": config.ELEVENLABS_OPTIONS["model_id"],
        "default_voice_female": config.DEFAULT_VOICE_FEMALE,
        "default_voice_male": config.DEFAULT_VOICE_MALE,
        "resolutions": ["768x448", "832x480", "1280x720", "1920x1080"],
        "default_resolution": "1280x720",
        "multitalk_enabled": config.MULTITALK_ENABLED and os.path.exists(config.MULTITALK_CKPT_DIR),
    }


# --- Auth (PR2) ---

@app.post("/api/auth/login")
async def auth_login(payload: dict):
    """Studio login. Body: {user_id, password}. Returns access_token + user."""
    user_id = (payload or {}).get("user_id") or ""
    password = (payload or {}).get("password") or ""
    return await auth_module.login(user_id, password)


@app.post("/api/auth/logout")
async def auth_logout(request: Request):
    user = auth_module.get_request_user(request)
    new_sid = await auth_module.logout(user["user_id"])
    return {"ok": True, "studio_token_version": new_sid}


@app.get("/api/auth/me")
async def auth_me(request: Request):
    return auth_module.me(auth_module.get_request_user(request))


# --- File Upload Endpoints ---

@app.post("/api/upload/host-image")
async def upload_host_image(file: UploadFile = File(...)):
    from utils.security import validate_image_upload

    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    ext = os.path.splitext(file.filename or "")[1] or ".png"
    filename = f"host_{uuid.uuid4().hex[:8]}{ext}"
    filepath = os.path.join(config.UPLOADS_DIR, filename)
    save_upload_file(file, filepath)
    validate_image_upload(filepath)  # Pillow magic-byte
    return {"filename": filename, "path": filepath}


@app.post("/api/upload/background-image")
async def upload_background_image(file: UploadFile = File(...)):
    """Upload background image for agent composition."""
    from utils.security import validate_image_upload

    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    ext = os.path.splitext(file.filename or "")[1] or ".png"
    filename = f"bg_{uuid.uuid4().hex[:8]}{ext}"
    filepath = os.path.join(config.UPLOADS_DIR, filename)
    save_upload_file(file, filepath)
    validate_image_upload(filepath)
    return {"filename": filename, "path": filepath}


@app.get("/api/upload/list")
async def list_uploads(kind: str = "image"):
    """List files already present in UPLOADS_DIR so the UI can pick one
    without re-uploading. Workaround for environments where the browser's
    file read or multipart POST is blocked by DLP/VPN — user scp's the file
    to uploads/ once, then selects it from this list in the UI.
    """
    exts = {
        "image": {".png", ".jpg", ".jpeg", ".webp"},
        "audio": {".wav", ".mp3", ".m4a", ".flac"},
    }.get(kind, {".png", ".jpg", ".jpeg", ".webp"})

    if not os.path.isdir(config.UPLOADS_DIR):
        return {"files": []}

    results = []
    for fname in os.listdir(config.UPLOADS_DIR):
        fp = os.path.join(config.UPLOADS_DIR, fname)
        if not os.path.isfile(fp):
            continue
        ext = os.path.splitext(fname)[1].lower()
        if ext not in exts:
            continue
        try:
            st = os.stat(fp)
        except OSError:
            continue
        results.append({
            "filename": fname,
            "path": fp,
            "url": f"/api/files/{fname}",
            "size": st.st_size,
            "modified": st.st_mtime,
        })
    results.sort(key=lambda r: r["modified"], reverse=True)
    return {"files": results[:200]}


@app.post("/api/upload/json")
async def upload_json(request: Request):
    """Alternative upload via JSON body with base64 content.

    Some client environments (corporate DPI proxies, certain antivirus, strict
    browser extensions) silently drop multipart/form-data POSTs. This endpoint
    accepts the same payload as /api/upload/* but as application/json, which
    typically passes through such middleware.

    Body: {
      kind: "host-image" | "background-image" | "reference-image" | "audio" | "reference-audio",
      filename: "whatever.png",
      content_base64: "iVBOR...",      # file bytes as base64
      mime_type: "image/png"           # optional; inferred from kind otherwise
    }
    """
    import base64
    from utils.security import validate_image_upload, validate_audio_upload

    body = await request.json()
    kind = (body.get("kind") or "reference-image").strip()
    filename_in = body.get("filename") or ""
    b64 = body.get("content_base64") or ""
    mime = body.get("mime_type") or ""

    if not b64:
        raise HTTPException(status_code=400, detail="content_base64 required")
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="content_base64 is not valid base64")

    if len(raw) > config.MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"File exceeds {config.MAX_UPLOAD_BYTES // 1_000_000}MB limit")

    is_audio = kind in ("audio", "reference-audio")
    if is_audio:
        ext = os.path.splitext(filename_in)[1] or ".mp3"
        prefix = "audio" if kind == "audio" else "ref_audio"
    else:
        if mime and not mime.startswith("image/"):
            raise HTTPException(status_code=400, detail="mime_type must be image/*")
        ext = os.path.splitext(filename_in)[1] or ".png"
        prefix = {"host-image": "host", "background-image": "bg", "reference-image": "ref_img"}.get(kind, "ref_img")

    out_name = f"{prefix}_{uuid.uuid4().hex[:8]}{ext}"
    out_path = os.path.join(config.UPLOADS_DIR, out_name)
    with open(out_path, "wb") as f:
        f.write(raw)

    if is_audio:
        validate_audio_upload(out_path)
    else:
        validate_image_upload(out_path)

    return {"filename": out_name, "path": out_path, "kind": kind, "size": len(raw)}


@app.post("/api/upload/reference-image")
async def upload_reference_image(file: UploadFile = File(...)):
    """Upload reference image (product, branding, etc.) for Gemini scene generation."""
    from utils.security import validate_image_upload

    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    ext = os.path.splitext(file.filename or "")[1] or ".png"
    filename = f"ref_img_{uuid.uuid4().hex[:8]}{ext}"
    filepath = os.path.join(config.UPLOADS_DIR, filename)
    save_upload_file(file, filepath)
    validate_image_upload(filepath)
    return {"filename": filename, "path": filepath}


@app.post("/api/preview/composite")
async def preview_composite(
    host_image_path: str = Form(...),
    bg_image_path: str = Form(...),
    resolution: str = Form("1280x720"),
    scale: float = Form(0.70),
    position: str = Form("center"),
):
    """Generate a single-agent composite preview image (host + background)."""
    import asyncio
    from utils.security import safe_upload_path

    host_image_path = safe_upload_path(host_image_path)
    bg_image_path = safe_upload_path(bg_image_path)
    if not os.path.exists(host_image_path):
        raise HTTPException(status_code=400, detail="Host image not found")
    if not os.path.exists(bg_image_path):
        raise HTTPException(status_code=400, detail="Background image not found")

    res_parts = resolution.split("x")
    target_h, target_w = int(res_parts[0]), int(res_parts[1])

    loop = asyncio.get_event_loop()
    from modules.image_compositor import compose_agent_image, release_models

    try:
        # compose_agent_image expects (width, height)
        result_path = await loop.run_in_executor(
            None,
            lambda: compose_agent_image(
                host_image_path, bg_image_path,
                target_size=(target_h, target_w),
                scale=scale, position=position,
            )
        )
    finally:
        await loop.run_in_executor(None, release_models)

    return {"path": result_path}


@app.post("/api/preview/composite-together")
async def preview_composite_together(
    host_image_paths: str = Form(...),  # JSON array of paths
    resolution: str = Form("1280x720"),
    layout: str = Form("split"),
    scene_prompt: str = Form(""),
    reference_image_paths: str = Form("[]"),  # JSON array of paths
):
    """Generate combined composite preview with Gemini scene generation."""
    import asyncio

    from utils.security import safe_upload_path

    host_paths = [safe_upload_path(p) for p in json.loads(host_image_paths)]
    ref_paths = [safe_upload_path(p) for p in json.loads(reference_image_paths)]
    if not host_paths:
        raise HTTPException(status_code=400, detail="No host images provided")
    for p in host_paths:
        if not os.path.exists(p):
            raise HTTPException(status_code=400, detail=f"Host image not found: {p}")

    res_parts = resolution.split("x")
    target_h, target_w = int(res_parts[0]), int(res_parts[1])

    loop = asyncio.get_event_loop()
    from modules.image_compositor import compose_agents_together, release_models

    try:
        # compositor expects (width, height) — "1280x720" → h=1280, w=720 → pass (h, w) as (w, h)
        results = await loop.run_in_executor(
            None,
            lambda: compose_agents_together(
                host_image_paths=host_paths,
                bg_image_path=os.path.join(config.UPLOADS_DIR, "dummy"),
                target_size=(target_h, target_w),
                layout=layout,
                scene_prompt=scene_prompt,
                reference_image_paths=ref_paths if ref_paths else None,
            )
        )
    finally:
        await loop.run_in_executor(None, release_models)

    full_image = results.pop("full", None)
    resp = {"paths": {str(k): v for k, v in results.items()}}
    if full_image:
        resp["full_image"] = full_image
    return resp


@app.post("/api/upload/reference-audio")
async def upload_reference_audio(file: UploadFile = File(...)):
    from utils.security import validate_audio_upload

    if not file.content_type or not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="File must be an audio file")

    ext = os.path.splitext(file.filename or "")[1] or ".mp3"
    filename = f"ref_{uuid.uuid4().hex[:8]}{ext}"
    filepath = os.path.join(config.UPLOADS_DIR, filename)
    save_upload_file(file, filepath)
    validate_audio_upload(filepath)  # ffprobe magic-byte
    return {"filename": filename, "path": filepath}


@app.post("/api/upload/audio")
async def upload_audio(file: UploadFile = File(...)):
    """Upload audio file directly for video generation (any audio)"""
    from utils.security import validate_audio_upload

    ext = os.path.splitext(file.filename or "")[1] or ".mp3"
    filename = f"audio_{uuid.uuid4().hex[:8]}{ext}"
    filepath = os.path.join(config.UPLOADS_DIR, filename)
    save_upload_file(file, filepath)
    validate_audio_upload(filepath)

    # Convert to 16kHz WAV if needed
    wav_path = filepath
    if not filepath.lower().endswith(".wav"):
        import subprocess
        wav_path = filepath.rsplit(".", 1)[0] + ".wav"
        subprocess.run(
            ["ffmpeg", "-y", "-i", filepath, "-ar", "16000", "-ac", "1", wav_path],
            check=True, capture_output=True,
        )
        os.remove(filepath)

    return {"filename": os.path.basename(wav_path), "path": wav_path}


# --- ElevenLabs TTS Endpoints ---

@app.get("/api/elevenlabs/voices")
async def list_elevenlabs_voices():
    """List available ElevenLabs voices"""
    if not config.ELEVENLABS_API_KEY:
        raise HTTPException(status_code=400, detail="ElevenLabs API key not configured. Set ELEVENLABS_API_KEY env var.")

    try:
        from modules.elevenlabs_tts import ElevenLabsTTS
        tts = ElevenLabsTTS(api_key=config.ELEVENLABS_API_KEY)
        voices = tts.list_voices()
        return {"voices": voices}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/elevenlabs/generate")
async def generate_elevenlabs_speech(
    text: str = Form(...),
    voice_id: str = Form(...),
    stability: float = Form(0.5),
    similarity_boost: float = Form(0.75),
    style: float = Form(0.0),
    speed: float = Form(1.0),
):
    """Generate speech using ElevenLabs TTS.

    speed: 0.5-1.8 multiplier (v3 voice_settings.speed). Previously the endpoint
    hardcoded this from config; now passed through so the Step 3 UI slider
    actually controls playback rate.
    """
    if not config.ELEVENLABS_API_KEY:
        raise HTTPException(status_code=400, detail="ElevenLabs API key not configured")

    if not 0.5 <= speed <= 1.8:
        raise HTTPException(status_code=400, detail=f"speed must be in [0.5, 1.8], got {speed}")

    try:
        from modules.elevenlabs_tts import ElevenLabsTTS
        tts = ElevenLabsTTS(
            api_key=config.ELEVENLABS_API_KEY,
            model_id=config.ELEVENLABS_OPTIONS["model_id"],
        )

        # Write to OUTPUTS_DIR (already in SAFE_ROOTS) so /api/files/<name> can
        # serve it for the Step 3 preview <audio>. TEMP_DIR is excluded from
        # SAFE_ROOTS for security and earlier we returned absolute paths the
        # frontend tried to URL-encode — both broke preview playback.
        filename = f"tts_{uuid.uuid4().hex[:8]}.wav"
        output_path = os.path.join(config.OUTPUTS_DIR, filename)

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None,
            lambda: tts.generate_speech(
                text=text,
                voice_id=voice_id,
                output_path=output_path,
                stability=stability,
                similarity_boost=similarity_boost,
                style=style,
                speed=speed,
                use_speaker_boost=config.ELEVENLABS_OPTIONS.get("use_speaker_boost", True),
                language_code=config.ELEVENLABS_OPTIONS.get("language_code", "ko"),
            ),
        )

        return {
            "filename": filename,
            "path": output_path,           # filesystem path — used by /api/generate as audio_path
            "url": f"/api/files/{filename}",  # serveable URL — used by Step 3 <audio> preview
        }
    except Exception as e:
        logger.error(f"ElevenLabs TTS failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/elevenlabs/clone-voice")
async def clone_voice(
    name: str = Form(...),
    file: UploadFile = File(...),
    description: str = Form(""),
):
    """Clone a voice from reference audio using ElevenLabs"""
    if not config.ELEVENLABS_API_KEY:
        raise HTTPException(status_code=400, detail="ElevenLabs API key not configured")

    # Save uploaded file
    ext = os.path.splitext(file.filename)[1]
    ref_path = os.path.join(config.UPLOADS_DIR, f"clone_ref_{uuid.uuid4().hex[:8]}{ext}")
    save_upload_file(file, ref_path)

    try:
        from modules.elevenlabs_tts import ElevenLabsTTS
        tts = ElevenLabsTTS(api_key=config.ELEVENLABS_API_KEY)

        loop = asyncio.get_event_loop()
        voice_id = await loop.run_in_executor(
            None,
            lambda: tts.clone_voice(name=name, reference_audio_path=ref_path, description=description),
        )

        return {"voice_id": voice_id, "name": name}
    except Exception as e:
        logger.error(f"Voice cloning failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# --- Video Generation Endpoints ---

@app.post("/api/generate")
async def generate_video(
    request: Request,
    audio_source: str = Form("upload"),  # "upload", "elevenlabs"
    host_image_path: Optional[str] = Form(None),
    audio_path: Optional[str] = Form(None),
    # ElevenLabs params (when audio_source="elevenlabs")
    script_text: str = Form(""),
    voice_id: Optional[str] = Form(None),
    stability: float = Form(0.5),
    similarity_boost: float = Form(0.75),
    style: float = Form(0.0),
    # FlashTalk params
    prompt: Optional[str] = Form(None),
    seed: int = Form(9999),
    cpu_offload: bool = Form(True),
    resolution: str = Form("1280x720"),
    # Gemini background generation
    scene_prompt: str = Form(""),
    reference_image_paths: str = Form("[]"),
    # Queue display label — frontend sends a human-readable summary so the
    # queue panel doesn't just show "Video generation" for every job.
    queue_label: Optional[str] = Form(None),
    # Full provenance snapshot as JSON — stored verbatim in the task queue
    # params so the render dashboard can later show "이렇게 만들었어요" from
    # the actual task data (host image, products, background, voice,
    # temperatures, etc.) instead of whatever state.* the wizard happens
    # to hold at view time. None → dashboard falls back to state.
    meta: Optional[str] = Form(None),
    # Playlist assignment at generate time (per docs/playlist-feature-plan.md
    # decision #3). Empty string / null → 미지정. Validation lives in the
    # manifest upsert path (decision #9: silent coerce on miss/cross-user).
    playlist_id: Optional[str] = Form(None),
):
    """Generate video from host image + audio"""
    from utils.security import safe_upload_path

    # Resolve + guard host image (body-field path traversal fix)
    if host_image_path:
        try:
            host_image_path = safe_upload_path(host_image_path)
        except HTTPException:
            host_image_path = None
    if not host_image_path or not os.path.exists(host_image_path):
        host_image_path = config.DEFAULT_HOST_IMAGE
    if not os.path.exists(host_image_path):
        raise HTTPException(status_code=404, detail=f"Host image not found: {host_image_path}")

    # Guard reference_image_paths too
    try:
        _ref_list = json.loads(reference_image_paths) if reference_image_paths else []
        reference_image_paths = json.dumps([safe_upload_path(p) for p in _ref_list])
    except (json.JSONDecodeError, HTTPException) as e:
        if isinstance(e, HTTPException):
            raise
        reference_image_paths = "[]"

    # Resolve audio
    audio_source_label = audio_source
    if audio_source == "elevenlabs":
        if not script_text.strip():
            raise HTTPException(status_code=400, detail="Script text required for ElevenLabs TTS")
        if not voice_id:
            raise HTTPException(status_code=400, detail="Voice ID required for ElevenLabs TTS")
        if not config.ELEVENLABS_API_KEY:
            raise HTTPException(status_code=400, detail="ElevenLabs API key not configured")

        # Generate TTS audio
        from modules.elevenlabs_tts import ElevenLabsTTS
        tts = ElevenLabsTTS(
            api_key=config.ELEVENLABS_API_KEY,
            model_id=config.ELEVENLABS_OPTIONS["model_id"],
        )
        audio_filename = f"tts_{uuid.uuid4().hex[:8]}.wav"
        audio_path = os.path.join(config.TEMP_DIR, audio_filename)
        tts.generate_speech(
            text=script_text,
            voice_id=voice_id,
            output_path=audio_path,
            stability=stability,
            similarity_boost=similarity_boost,
            style=style,
            speed=config.ELEVENLABS_OPTIONS.get("speed", 1.0),
            use_speaker_boost=config.ELEVENLABS_OPTIONS.get("use_speaker_boost", True),
            language_code=config.ELEVENLABS_OPTIONS.get("language_code", "ko"),
        )
        audio_source_label = f"elevenlabs:{voice_id}"

    elif audio_source == "upload":
        # Guard body-field audio_path (was: attacker could set audio_path="/etc/passwd")
        if audio_path:
            try:
                audio_path = safe_upload_path(audio_path)
            except HTTPException:
                audio_path = None
        if not audio_path or not os.path.exists(audio_path):
            audio_path = config.DEFAULT_AUDIO
        if not os.path.exists(audio_path):
            raise HTTPException(status_code=404, detail="Audio file not found")
    else:
        raise HTTPException(status_code=400, detail=f"Invalid audio_source: {audio_source}")

    # Resolve prompt
    if not prompt:
        prompt = config.FLASHTALK_OPTIONS["default_prompt"]

    # Create task and add to queue
    task_id = uuid.uuid4().hex
    create_task(task_id)
    update_task(task_id, "queued", 0.0, "큐 대기 중...")

    ref_paths = json.loads(reference_image_paths) if reference_image_paths else []

    # Parse the meta snapshot. Malformed JSON is non-fatal — log and skip so
    # a broken meta field never blocks the actual generation.
    meta_obj = None
    if meta:
        try:
            meta_obj = json.loads(meta)
        except json.JSONDecodeError as e:
            logger.warning("Invalid meta JSON on /api/generate: %s", e)

    user = auth_module.get_request_user(request)
    # Normalize empty-string playlist_id to None — frontends can't always
    # send null in multipart/form-data.
    pid = playlist_id if playlist_id not in ("", "null", None) else None
    await task_queue.enqueue(
        task_id=task_id,
        task_type="generate",
        params={
            "host_image": host_image_path,
            "audio_path": audio_path,
            "audio_source_label": audio_source_label,
            "prompt": prompt,
            "seed": seed,
            "cpu_offload": cpu_offload,
            "script_text": script_text,
            "resolution": resolution,
            "scene_prompt": scene_prompt,
            "reference_image_paths": ref_paths,
            "meta": meta_obj,
            "playlist_id": pid,
        },
        user_id=user["user_id"],
        label=_build_queue_label(queue_label, script_text, resolution, host_image_path),
    )

    queue_status = await task_queue.get_status(user_id=user["user_id"])
    position = queue_status["total_pending"]

    return {"task_id": task_id, "message": "Video generation queued", "queue_position": position}


# SSE keep-alive constants. The Vite dev proxy idles connections out at 120s
# (vite.config.js `proxyTimeout`); during MultiTalk inference there can be 60-
# 180s between progress updates, so we send `: heartbeat` comment frames to
# keep the chunked stream alive. Comments don't trigger EventSource.onmessage
# on the browser but DO reset the proxy's idle timer. Constants are module
# scope so tests can monkeypatch a smaller HEARTBEAT_SEC.
SSE_HEARTBEAT_SEC = 15.0
SSE_POLL_SEC = 0.5


async def _progress_event_generator(task_id: str):
    """Yield SSE frames for a single task until it reaches a terminal stage.

    Pulled out of progress_stream so tests can drive it directly without
    spinning up uvicorn / TestClient. Stops when the task vanishes from
    task_states OR reaches stage in {"complete", "error"} AND all queued
    updates have been flushed.

    The "flush before break" rule matters because the worker can append the
    final update and set state.stage="complete" in two non-atomic steps —
    if we broke purely on stage we'd race past the user-visible "완료!"
    message. Re-fetching state after each yield closes that race.
    """
    import time as _t
    last_count = 0
    last_send = _t.monotonic()
    while True:
        state = task_states.get(task_id)
        if not state:
            break

        updates = state["updates"]
        if len(updates) > last_count:
            for u in updates[last_count:]:
                yield f"data: {json.dumps(u)}\n\n"
            last_count = len(updates)
            last_send = _t.monotonic()
        elif _t.monotonic() - last_send >= SSE_HEARTBEAT_SEC:
            yield ": heartbeat\n\n"
            last_send = _t.monotonic()

        # Re-fetch state and re-check pending-updates before deciding to
        # exit — protects against the worker writing "final update + complete
        # stage" between our yield and our break check.
        state = task_states.get(task_id)
        if not state:
            break
        if state["stage"] in ("complete", "error") and len(state["updates"]) <= last_count:
            break

        await asyncio.sleep(SSE_POLL_SEC)


@app.get("/api/progress/{task_id}")
async def progress_stream(task_id: str, request: Request):
    """SSE endpoint for real-time progress. Owner-scoped (admins see all)."""
    user = auth_module.get_request_user(request)
    if user.get("role") not in ("admin", "master"):
        owner = await task_queue.get_task_owner(task_id)
        if owner is not None and owner != user["user_id"]:
            raise HTTPException(status_code=404, detail="Task not found")
    if task_id not in task_states:
        raise HTTPException(status_code=404, detail="Task not found")
    return StreamingResponse(_progress_event_generator(task_id), media_type="text/event-stream")


@app.get("/api/tasks/{task_id}/state", response_model=TaskStateSnapshot)
async def task_state_snapshot(task_id: str, request: Request):
    """Plain-JSON snapshot of current task state — polling alternative to the
    SSE endpoint above. Exists because some client environments (certain
    browser extensions, corporate proxies, weird connection-pool states) block
    EventSource while allowing ordinary fetch requests, leaving the render
    dashboard permanently stuck at the placeholder 0%. The polling path uses
    this endpoint; SSE stays in place for clients that can use it.

    Fallback ordering:
      1. in-memory `task_states` — the live, detailed state (has all
         the sub-stage progress the worker emits)
      2. persistent queue — if the task exists in the queue but hasn't
         been picked up yet (e.g. right after a backend restart, when
         `task_states` was wiped but `_recover_interrupted` flipped
         running→pending), synthesize a minimal "queued/loading"
         state so the frontend keeps polling instead of reporting the
         task as failed after 8 consecutive 404s (~12s window).
      3. only 404 if the task genuinely doesn't exist anywhere.
    """
    user = auth_module.get_request_user(request)
    if user.get("role") not in ("admin", "master"):
        owner = await task_queue.get_task_owner(task_id)
        if owner is not None and owner != user["user_id"]:
            raise HTTPException(status_code=404, detail="Task not found")
    state = task_states.get(task_id)
    if state:
        return {
            "task_id": task_id,
            "stage": state.get("stage"),
            "progress": state.get("progress"),
            "message": state.get("message"),
            "error": state.get("error"),
            "output_path": state.get("output_path"),
        }

    # Backend-restart recovery window — task is in the persistent queue
    # but the worker hasn't rebuilt `task_states` for it yet. Synthesize
    # enough state that the frontend's polling loop doesn't give up.
    queue = await task_queue.get_status()
    for entry in queue.get("running", []):
        if entry.get("task_id") == task_id:
            return {
                "task_id": task_id,
                "stage": "loading",
                "progress": 0.0,
                "message": "작업 복구 중…",
                "error": None,
                "output_path": None,
            }
    for entry in queue.get("pending", []):
        if entry.get("task_id") == task_id:
            return {
                "task_id": task_id,
                "stage": "queued",
                "progress": 0.0,
                "message": "대기열에서 차례를 기다리는 중…",
                "error": None,
                "output_path": None,
            }
    for entry in queue.get("recent", []):
        if entry.get("task_id") == task_id:
            status = entry.get("status") or "completed"
            if status == "completed":
                return {
                    "task_id": task_id,
                    "stage": "complete",
                    "progress": 1.0,
                    "message": "완료",
                    "error": None,
                    "output_path": None,
                }
            return {
                "task_id": task_id,
                "stage": "error",
                "progress": 0.0,
                "message": entry.get("label"),
                "error": entry.get("error") or f"작업이 {status} 상태입니다",
                "output_path": None,
            }

    raise HTTPException(status_code=404, detail="Task not found")


@app.api_route("/api/videos/{task_id}", methods=["GET", "HEAD"])
async def get_video(task_id: str, download: bool = False):
    """Serve generated video. HEAD returns headers only (used by the
    RenderDashboard to pull Content-Length without downloading the mp4)."""
    # Check task state
    state = task_states.get(task_id)
    if state and state.get("output_path") and os.path.exists(state["output_path"]):
        headers = {}
        if download:
            headers["Content-Disposition"] = f'attachment; filename="{os.path.basename(state["output_path"])}"'
        else:
            headers["Content-Disposition"] = "inline"
        return FileResponse(state["output_path"], media_type="video/mp4", headers=headers)

    # Fallback: studio_results lookup (no user filter — public endpoint per
    # plan §6 because <video> tags can't send Authorization headers).
    from modules.repositories import studio_result_repo as _result_repo
    doc = await _result_repo.find_by_task_id(task_id)
    if doc:
        # Prefer the absolute video_path the worker recorded; fall back to
        # resolving the storage_key. Either way the file must still exist.
        candidate = doc.get("video_path")
        if not candidate and doc.get("video_storage_key"):
            from modules import storage as _storage
            try:
                candidate = str(_storage.media_store.local_path_for(doc["video_storage_key"]))
            except ValueError:
                candidate = None
        if candidate and os.path.exists(candidate):
            headers = {"Content-Disposition": "attachment" if download else "inline"}
            return FileResponse(candidate, media_type="video/mp4", headers=headers)

    raise HTTPException(status_code=404, detail="Video not found")


@app.get("/api/history", response_model=HistoryResponse)
async def get_history(
    request: Request,
    limit: int = 50,
    playlist_id: Optional[str] = None,
):
    """Return the authenticated user's recent completed renders.

    PR5 cutover: was outputs/video_history.json (global), now studio_results
    scoped to the calling user (admin/master sees all).

    Optional `playlist_id` query param filters results (plan decision #12):
        omitted        → all renders
        "unassigned"   → only renders with no playlist
        <hex id>       → exact playlist match. Unknown / deleted id returns
                         200 [] so cross-tab playlist deletion doesn't break
                         filter-UI restoration.
    """
    from modules.repositories import studio_result_repo as _result_repo
    user = auth_module.get_request_user(request)
    rows = await _result_repo.list_completed(
        user["user_id"], limit=limit, playlist_id=playlist_id
    )
    # Project the legacy `videos` shape so the SPA's existing parser keeps working.
    videos = []
    for r in rows:
        videos.append({
            "task_id": r["task_id"],
            "timestamp": (r.get("completed_at").isoformat()
                          if hasattr(r.get("completed_at"), "isoformat")
                          else r.get("completed_at")),
            "script_text": (r.get("params") or {}).get("script_text", ""),
            "host_image": (r.get("params") or {}).get("host_image", ""),
            "audio_source": (r.get("params") or {}).get("audio_source_label", ""),
            "output_path": r.get("video_path"),
            "file_size": r.get("video_bytes", 0),
            "video_url": r.get("video_url") or f"/api/videos/{r['task_id']}",
            "generation_time": r.get("generation_time_sec"),
        })
    return {"total": len(videos), "videos": videos}


# ========================================
# Conversation Generation
# ========================================

async def generate_conversation_task(
    task_id: str,
    dialog_data: dict,
    layout: str,
    prompt: str,
    seed: int,
    cpu_offload: bool,
    user_id: Optional[str] = None,
    resolution: str = "1280x720",
    playlist_id: Optional[str] = None,
):
    """Run multi-agent conversation video generation in background."""
    global pipeline, pipeline_lock

    # See generate_video_task for rationale: recovered tasks have no
    # task_states row after a backend restart, so update_task() silently
    # no-ops unless we re-init here.
    if task_id not in task_states:
        create_task(task_id)

    start_time = time.time()

    async with pipeline_lock:
        logger.info(f"Conversation task {task_id} acquired lock, starting generation...")

        try:
            loop = asyncio.get_event_loop()

            # Parse dialog
            from modules.dialog_parser import parse_dialog_json
            dialog = parse_dialog_json(dialog_data)

            errors = dialog.validate()
            if errors:
                set_task_error(task_id, f"스크립트 검증 실패: {'; '.join(errors)}")
                return

            def progress_cb(stage, progress, message):
                update_task(task_id, stage, progress, message)

            # Determine composite mode for 2-person split. Snap resolution to
            # 16× for the same FlashTalk VAE×patch alignment constraint.
            res_parts = resolution.split("x")
            target_h, target_w = _snap_resolution_to_16(int(res_parts[0]), int(res_parts[1]))
            composite_mode = config.COMPOSITE_MODE if (layout == "split" and len(dialog.agents) == 2) else "hstack"
            use_multitalk = (composite_mode == "multitalk")
            use_alpha = (composite_mode == "alpha")
            bg_only_path = None
            full_image_path = None

            # Check for scene_prompt (Gemini background generation)
            scene_prompt = ""
            ref_paths = []
            for agent in dialog.agents.values():
                if agent.scene_prompt:
                    scene_prompt = agent.scene_prompt
                    ref_paths = getattr(agent, 'reference_image_paths', []) or []
                    break

            # Stage 0: Background generation
            if scene_prompt:
                update_task(task_id, "compositing_bg", 0.02, "배경 생성 중 (Gemini)...")
                from modules.image_compositor import compose_agents_together, generate_background_only, release_models

                if use_alpha:
                    # Alpha mode: generate background-only + solid-bg per-agent images
                    def gen_alpha_assets():
                        from modules.image_compositor import compose_agent_on_solid_bg
                        # 1) Gemini background-only (no people)
                        # compositor expects (width, height)
                        path = generate_background_only(
                            scene_prompt=scene_prompt,
                            target_size=(target_h, target_w),
                            reference_image_paths=ref_paths if ref_paths else None,
                        )
                        # 2) Per-agent: solid gray background + person (easy rembg extraction)
                        agent_list = list(dialog.agents.values())
                        for agent in agent_list:
                            solid_path = compose_agent_on_solid_bg(
                                host_image_path=agent.face_image,
                                target_size=(target_h, target_w),
                                bg_color=(180, 180, 180),
                            )
                            logger.info(f"Agent {agent.name}: solid bg -> {solid_path}")
                            agent.face_image = solid_path
                        release_models()
                        return path

                    bg_only_path = await loop.run_in_executor(None, gen_alpha_assets)
                    if not bg_only_path:
                        logger.warning("Background-only generation failed, falling back to hstack")
                        use_alpha = False

                elif use_multitalk:
                    # MultiTalk mode: generate full scene with people
                    def compose_multitalk_bg():
                        agent_list = list(dialog.agents.values())
                        host_paths = [a.face_image for a in agent_list]
                        composed = compose_agents_together(
                            host_image_paths=host_paths,
                            bg_image_path=os.path.join(config.UPLOADS_DIR, "dummy"),
                            target_size=(target_h, target_w),
                            layout=layout,
                            scene_prompt=scene_prompt,
                            reference_image_paths=ref_paths if ref_paths else None,
                            multitalk=True,
                        )
                        result_full = composed.get("full")
                        release_models()
                        return result_full

                    full_image_path = await loop.run_in_executor(None, compose_multitalk_bg)

                else:
                    # hstack mode: generate per-agent composed images
                    def compose_hstack_bg():
                        agent_list = list(dialog.agents.values())
                        host_paths = [a.face_image for a in agent_list]
                        composed = compose_agents_together(
                            host_image_paths=host_paths,
                            bg_image_path=os.path.join(config.UPLOADS_DIR, "dummy"),
                            target_size=(target_h, target_w),
                            layout=layout,
                            scene_prompt=scene_prompt,
                            reference_image_paths=ref_paths if ref_paths else None,
                        )
                        for i, agent in enumerate(agent_list):
                            if i in composed:
                                agent.face_image = composed[i]
                                logger.info(f"Agent {agent.name}: composed -> {composed[i]}")
                        release_models()

                    await loop.run_in_executor(None, compose_hstack_bg)

            # Stage 1: Load appropriate pipeline
            if use_multitalk:
                update_task(task_id, "loading", 0.05, "MultiTalk 모델 로딩 중...")
                await loop.run_in_executor(None, lambda: _ensure_multitalk_pipeline(cpu_offload))
            else:
                update_task(task_id, "loading", 0.05, "FlashTalk 모델 로딩 중...")
                await loop.run_in_executor(None, lambda: _ensure_flashtalk_pipeline(cpu_offload))

            # Stage 2: Generate all turns
            idle_videos = {}

            if use_multitalk:
                update_task(task_id, "generating", 0.1, f"MultiTalk 영상 생성 시작 ({len(dialog.turns)}턴)...")

                from modules.multitalk_inference import generate_conversation_multitalk
                segments = await loop.run_in_executor(
                    None,
                    lambda: generate_conversation_multitalk(
                        dialog=dialog,
                        pipeline=multitalk_pipeline,
                        full_image_path=full_image_path,
                        prompt=prompt,
                        seed=seed,
                        resolution=resolution,
                        progress_callback=progress_cb,
                    )
                )
            else:
                mode_label = "Alpha 합성" if use_alpha else "FlashTalk"
                update_task(task_id, "generating", 0.1, f"{mode_label} 영상 생성 시작 ({len(dialog.turns)}턴)...")

                from modules.conversation_generator import generate_conversation
                segments, idle_videos = await loop.run_in_executor(
                    None,
                    lambda: generate_conversation(
                        dialog=dialog,
                        pipeline=pipeline,
                        prompt=prompt,
                        seed=seed,
                        resolution=resolution,
                        layout=layout,
                        progress_callback=progress_cb,
                    )
                )

            # Stage 3: Composite
            composite_label = "알파 합성" if use_alpha else ("MultiTalk" if use_multitalk else layout)
            update_task(task_id, "compositing", 0.85, f"영상 합성 중 ({composite_label})...")

            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"conv_{timestamp}_{task_id[:8]}.mp4"
            output_path = os.path.join(config.OUTPUTS_DIR, filename)

            from modules.conversation_compositor import composite_conversation
            await loop.run_in_executor(
                None,
                lambda: composite_conversation(
                    segments=segments,
                    agents=dialog.agents,
                    layout=layout,
                    output_path=output_path,
                    resolution=resolution,
                    idle_videos=idle_videos,
                    multitalk=use_multitalk,
                    alpha_composite=use_alpha,
                    bg_image_path=bg_only_path,
                )
            )

            task_states[task_id]["output_path"] = output_path
            generation_time = time.time() - start_time

            # Build script summary
            script_summary = " / ".join(
                f"{t.agent_id}: {t.text[:30]}..." if len(t.text) > 30 else f"{t.agent_id}: {t.text}"
                for t in dialog.turns[:3]
            )
            if len(dialog.turns) > 3:
                script_summary += f" ... (+{len(dialog.turns) - 3}턴)"

            # Result manifest persisted to studio_results (PR5).
            video_bytes = os.path.getsize(output_path) if os.path.exists(output_path) else 0
            from modules import storage as _storage
            try:
                video_storage_key = _storage.media_store.key_from_path(output_path)
            except ValueError:
                video_storage_key = None
            manifest = {
                "task_id": task_id,
                "type": "conversation",
                "status": "completed",
                "completed_at": datetime.now(),
                "generation_time_sec": round(generation_time, 2),
                "video_url": f"/api/videos/{task_id}",
                "video_storage_key": video_storage_key,
                "video_path": output_path,
                "video_bytes": video_bytes,
                "video_filename": os.path.basename(output_path),
                "params": {
                    "script_summary": script_summary,
                    "layout": layout,
                    "host_image": "multi-agent",
                    "audio_source_label": f"conversation:{layout}",
                },
                "meta": None,
                "playlist_id": playlist_id,
            }
            if user_id:
                try:
                    from modules.repositories import studio_result_repo as _result_repo
                    await _result_repo.upsert(user_id, manifest)
                except Exception as e:
                    logger.warning(f"Conversation task {task_id}: manifest upsert failed: {e}")

            update_task(task_id, "complete", 1.0, f"대화 영상 생성 완료! ({generation_time:.1f}초)")
            logger.info(f"Conversation task {task_id} completed: {output_path}")

            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

        except Exception as e:
            logger.error(f"Conversation task {task_id} failed: {e}")
            import traceback
            traceback.print_exc()
            set_task_error(task_id, f"대화 영상 생성 실패: {str(e)}")

            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

            # Re-raise so the queue worker records status="error" (same reason
            # as generate_video_task — prevents "completed + 404" ghost state).
            raise


@app.post("/api/generate-conversation")
async def generate_conversation_endpoint(
    request: Request,
    dialog_data: str = Form(...),  # JSON string
    layout: str = Form("split"),
    prompt: Optional[str] = Form(None),
    seed: int = Form(9999),
    cpu_offload: bool = Form(True),
    resolution: str = Form("1280x720"),
    # Symmetry with /api/generate — see comment there.
    playlist_id: Optional[str] = Form(None),
):
    """Generate multi-agent conversation video."""
    try:
        parsed_data = json.loads(dialog_data)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON in dialog_data")

    if not parsed_data.get("agents") or len(parsed_data["agents"]) < 2:
        raise HTTPException(status_code=400, detail="최소 2명의 에이전트가 필요합니다")
    if not parsed_data.get("dialog") or len(parsed_data["dialog"]) == 0:
        raise HTTPException(status_code=400, detail="최소 1개의 대화 턴이 필요합니다")

    if not prompt:
        # Use MultiTalk prompt for split layout with 2 agents
        if layout == "split" and len(parsed_data.get("agents", {})) == 2 and config.MULTITALK_ENABLED:
            prompt = config.MULTITALK_OPTIONS["default_prompt"]
        else:
            prompt = config.FLASHTALK_OPTIONS["default_prompt"]

    task_id = uuid.uuid4().hex
    create_task(task_id)
    update_task(task_id, "queued", 0.0, "큐 대기 중...")

    # Build label from first dialog turn
    dialog_turns = parsed_data.get("dialog", [])
    label = dialog_turns[0]["text"][:50] if dialog_turns else "Conversation"

    user = auth_module.get_request_user(request)
    pid = playlist_id if playlist_id not in ("", "null", None) else None
    await task_queue.enqueue(
        task_id=task_id,
        task_type="conversation",
        params={
            "dialog_data": parsed_data,
            "layout": layout,
            "prompt": prompt,
            "seed": seed,
            "cpu_offload": cpu_offload,
            "resolution": resolution,
            "playlist_id": pid,
        },
        user_id=user["user_id"],
        label=label,
    )

    queue_status = await task_queue.get_status(user_id=user["user_id"])
    position = queue_status["total_pending"]

    return {"task_id": task_id, "message": "Conversation video generation queued", "queue_position": position}


# ========================================
# Queue Status Endpoints
# ========================================

@app.get("/api/queue", response_model=QueueSnapshot)
async def get_queue_status(request: Request):
    """Get queue status scoped to the authenticated user (admin sees all)."""
    user = auth_module.get_request_user(request)
    scope = None if user.get("role") in ("admin", "master") else user["user_id"]
    return await task_queue.get_status(user_id=scope)


@app.delete("/api/queue/{task_id}")
async def cancel_queued_task(task_id: str, request: Request):
    """Cancel a pending task. Owner-only (admins/masters can cancel any)."""
    user = auth_module.get_request_user(request)
    is_admin = user.get("role") in ("admin", "master")
    outcome = await task_queue.cancel_task(
        task_id, requesting_user_id=user["user_id"], is_admin=is_admin,
    )
    if outcome == "not_found":
        raise HTTPException(status_code=404, detail="Task not found or not in pending state")
    if outcome == "forbidden":
        # Don't leak whether task exists; return 404 (per plan auth posture)
        raise HTTPException(status_code=404, detail="Task not found or not in pending state")
    # Also update task_states
    if task_id in task_states:
        set_task_error(task_id, "사용자가 작업을 취소했습니다")
    return {"message": "Task cancelled", "task_id": task_id}


def _synthesize_result_from_queue(entry: dict) -> dict:
    """Build a result manifest on the fly from a task_queue entry.

    Used as a fallback for completed tasks that predate the manifest writer —
    their outputs/results/{task_id}.json doesn't exist, but we still have
    their params (and possibly meta) in task_queue.json. Synthesized
    manifests mirror the schema of real ones so the frontend doesn't need
    a separate code path.
    """
    task_id = entry["task_id"]
    params = entry.get("params", {}) or {}
    meta = params.get("meta")

    # Best effort — find the output file by scanning OUTPUTS_DIR for the
    # {task_id[:8]} suffix the writer uses. Missing file is fine, just 0.
    video_path = None
    video_bytes = 0
    try:
        short = task_id[:8]
        for name in os.listdir(config.OUTPUTS_DIR):
            if name.endswith(".mp4") and short in name:
                p = os.path.join(config.OUTPUTS_DIR, name)
                if os.path.isfile(p):
                    video_path = p
                    video_bytes = os.path.getsize(p)
                    break
    except Exception:
        pass

    # generation_time from queue timestamps when both are present
    gen_sec = None
    try:
        if entry.get("started_at") and entry.get("completed_at"):
            from datetime import datetime as _dt
            s = _dt.fromisoformat(entry["started_at"])
            c = _dt.fromisoformat(entry["completed_at"])
            gen_sec = round((c - s).total_seconds(), 2)
    except Exception:
        pass

    return {
        "task_id": task_id,
        "type": entry.get("type", "generate"),
        "status": entry.get("status", "completed"),
        "created_at": entry.get("created_at"),
        "started_at": entry.get("started_at"),
        "completed_at": entry.get("completed_at"),
        "generation_time_sec": gen_sec,
        "video_url": f"/api/videos/{task_id}",
        "video_path": video_path,
        "video_bytes": video_bytes,
        "video_filename": os.path.basename(video_path) if video_path else None,
        # No resolution_actual — the snap wasn't recorded for pre-manifest
        # tasks. Frontend treats missing fields as "—".
        "params": {
            "host_image": params.get("host_image"),
            "audio_path": params.get("audio_path"),
            "audio_source_label": params.get("audio_source_label"),
            "prompt": params.get("prompt"),
            "seed": params.get("seed"),
            "cpu_offload": params.get("cpu_offload"),
            "script_text": params.get("script_text", ""),
            "resolution_requested": params.get("resolution"),
            "resolution_actual": None,
            "scene_prompt": params.get("scene_prompt", ""),
            "reference_image_paths": params.get("reference_image_paths", []),
        },
        "meta": meta,
        "error": entry.get("error"),
        "synthesized": True,
    }


@app.get("/api/results/{task_id}", response_model=ResultManifest)
async def get_result(task_id: str, request: Request):
    """Return the result manifest for a completed task. Owner-scoped.

    PR5: reads from studio_results. Falls back to synthesizing from the
    task_queue snapshot for in-flight tasks the worker hasn't yet upserted.
    """
    if not task_id or "/" in task_id or "\\" in task_id or ".." in task_id:
        raise HTTPException(status_code=400, detail="Invalid task_id")

    from modules.repositories import studio_result_repo as _result_repo
    user = auth_module.get_request_user(request)
    is_admin = user.get("role") in ("admin", "master")

    # Primary path — studio_results.
    if is_admin:
        doc = await _result_repo.find_by_task_id(task_id)
    else:
        doc = await _result_repo.get(user["user_id"], task_id)
        if doc is None:
            # Cross-check the queue: if the user owns the task but the
            # manifest hasn't landed yet, fall through to the synthesizer.
            owner = await task_queue.get_task_owner(task_id)
            if owner is not None and owner != user["user_id"]:
                raise HTTPException(status_code=404, detail="Task not found")
    if doc is not None:
        # Strip user_id from the returned payload — the SPA doesn't need it
        # and we don't want to expose it indirectly.
        doc.pop("user_id", None)
        return doc

    # Fallback — in-flight tasks not yet persisted to studio_results.
    if not is_admin:
        owner = await task_queue.get_task_owner(task_id)
        if owner is not None and owner != user["user_id"]:
            raise HTTPException(status_code=404, detail="Task not found")
    status = await task_queue.get_status()
    for bucket in ("running", "pending", "recent"):
        for entry in status.get(bucket, []):
            if entry.get("task_id") == task_id:
                return _synthesize_result_from_queue(entry)

    raise HTTPException(status_code=404, detail=f"Result for task {task_id} not found")


@app.get("/api/files/{filename:path}")
async def get_file(filename: str):
    """Serve files. Accepts both legacy (bucket-less) and PR3 storage_key forms.

    Examples:
      /api/files/outputs/hosts/saved/x.png   ← PR3 storage_key
      /api/files/hosts/saved/x.png           ← legacy (still resolves)
      /api/files/ref_img_abc.png             ← legacy (probes UPLOADS)

    Bucket-prefixed keys go through `modules.storage` (rejects `..`).
    Legacy filenames probe every bucket dir and pass through `safe_upload_path`
    for the final realpath-containment check.
    """
    from utils.security import safe_upload_path
    from modules.storage import resolve_legacy_or_keyed

    resolved = resolve_legacy_or_keyed(filename)
    if resolved is None:
        raise HTTPException(status_code=404, detail="File not found")
    # Defense in depth — confirm realpath stays inside a safe root even if
    # the storage layer's traversal check is somehow bypassed.
    filepath = safe_upload_path(str(resolved))

    ext = os.path.splitext(filename)[1].lower()
    media_types = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".wav": "audio/wav", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
    }
    return FileResponse(filepath, media_type=media_types.get(ext, "application/octet-stream"))


# ========================================
# HostStudio Phase 1 — Host Maker (Stage 1)
# ========================================


@app.post("/api/host/generate")
async def host_generate(
    mode: str = Form(...),
    prompt: Optional[str] = Form(None),
    extraPrompt: Optional[str] = Form(None),
    negativePrompt: Optional[str] = Form(None),
    builder: Optional[str] = Form(None),  # JSON dict
    faceRefPath: Optional[str] = Form(None),
    outfitRefPath: Optional[str] = Form(None),
    styleRefPath: Optional[str] = Form(None),
    faceStrength: float = Form(0.7),
    outfitStrength: float = Form(0.7),
    # Free-text outfit description — used INSTEAD of (or alongside) the
    # outfit reference image. Lets users describe the outfit when they have
    # no reference photo handy.
    outfitText: Optional[str] = Form(None),
    # JSON array of seeds. Frontend passes fresh randoms on "다시 만들기"
    # so retry produces new variants instead of the deterministic default
    # set. None → backend falls back to FIXED_DEFAULT_SEEDS.
    seeds: Optional[str] = Form(None),
    imageSize: str = Form("1K"),
    n: int = Form(4),
    temperature: Optional[float] = Form(None),
):
    """Generate N=4 host candidates via Gemini (Phase 1).

    temperature: optional 0.0-2.0 sampling knob. None → Gemini default.
    UI exposes 0.4 (conservative) / 0.7 (balanced) / 1.0 (varied).
    """
    from utils.security import safe_upload_path
    from modules.host_generator import generate_host_candidates

    face = safe_upload_path(faceRefPath) if faceRefPath else None
    outfit = safe_upload_path(outfitRefPath) if outfitRefPath else None
    style = safe_upload_path(styleRefPath) if styleRefPath else None

    builder_dict = None
    if builder:
        try:
            builder_dict = json.loads(builder)
            if not isinstance(builder_dict, dict):
                raise ValueError
        except (json.JSONDecodeError, ValueError):
            raise HTTPException(status_code=400, detail="builder must be a JSON object")

    if temperature is not None and not 0.0 <= temperature <= 2.0:
        raise HTTPException(status_code=400, detail=f"temperature must be in [0.0, 2.0], got {temperature}")

    parsed_seeds = _parse_seeds_form(seeds)

    try:
        result = await generate_host_candidates(
            mode=mode,
            text_prompt=prompt,
            face_ref_path=face,
            outfit_ref_path=outfit,
            style_ref_path=style,
            extra_prompt=extraPrompt,
            builder=builder_dict,
            negative_prompt=negativePrompt,
            face_strength=faceStrength,
            outfit_strength=outfitStrength,
            outfit_text=outfitText,
            seeds=parsed_seeds,
            image_size=_validate_image_size(imageSize),
            n=n,
            temperature=temperature,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return result


@app.post("/api/host/generate/stream")
async def host_generate_stream(
    request: Request,
    mode: str = Form(...),
    prompt: Optional[str] = Form(None),
    extraPrompt: Optional[str] = Form(None),
    negativePrompt: Optional[str] = Form(None),
    builder: Optional[str] = Form(None),  # JSON dict
    faceRefPath: Optional[str] = Form(None),
    outfitRefPath: Optional[str] = Form(None),
    styleRefPath: Optional[str] = Form(None),
    faceStrength: float = Form(0.7),
    outfitStrength: float = Form(0.7),
    outfitText: Optional[str] = Form(None),
    seeds: Optional[str] = Form(None),
    # Gemini image_size — shared between Step 1 and Step 2 so the reference
    # resolution matches the target. "1K" (default, fast) | "2K" (sharper,
    # ~2-4× time). Rejected for any other value.
    imageSize: str = Form("1K"),
    n: int = Form(4),
    temperature: Optional[float] = Form(None),
):
    """SSE variant of /api/host/generate — yields one event per completed
    candidate instead of blocking on the slowest Gemini call.

    Frontend consumes this via fetch + manual SSE parse (EventSource is GET-only)
    and appends each 'candidate' event to the variants grid as it arrives.
    """
    from utils.security import safe_upload_path
    from modules.host_generator import stream_host_candidates
    from modules.repositories import studio_host_repo as host_repo

    user = auth_module.get_request_user(request)
    user_id = user["user_id"]
    face = safe_upload_path(faceRefPath) if faceRefPath else None
    outfit = safe_upload_path(outfitRefPath) if outfitRefPath else None
    style = safe_upload_path(styleRefPath) if styleRefPath else None

    builder_dict = None
    if builder:
        try:
            builder_dict = json.loads(builder)
            if not isinstance(builder_dict, dict):
                raise ValueError
        except (json.JSONDecodeError, ValueError):
            raise HTTPException(status_code=400, detail="builder must be a JSON object")

    if temperature is not None and not 0.0 <= temperature <= 2.0:
        raise HTTPException(status_code=400, detail=f"temperature must be in [0.0, 2.0], got {temperature}")

    async def events():
        batch_id = f"batch_{uuid.uuid4().hex[:8]}"
        saved_paths: list = []
        try:
            async for evt in stream_host_candidates(
                mode=mode,
                text_prompt=prompt,
                face_ref_path=face,
                outfit_ref_path=outfit,
                style_ref_path=style,
                extra_prompt=extraPrompt,
                builder=builder_dict,
                negative_prompt=negativePrompt,
                face_strength=faceStrength,
                outfit_strength=outfitStrength,
                outfit_text=outfitText,
                seeds=_parse_seeds_form(seeds),
                image_size=_validate_image_size(imageSize),
                n=n,
                temperature=temperature,
            ):
                if evt.get("type") == "candidate" and evt.get("path"):
                    saved_paths.append(evt["path"])
                if evt.get("type") == "done" and saved_paths:
                    try:
                        await host_repo.record_batch(user_id, "1-host", saved_paths, batch_id)
                        await host_repo.cleanup_after_generate(user_id, "1-host", batch_id)
                        state = await host_repo.get_state(user_id, "1-host")
                        evt["batch_id"] = batch_id
                        evt["prev_selected"] = state["prev_selected"]
                    except Exception as le:
                        logger.error("host lifecycle bookkeeping failed: %s", le)
                        evt["lifecycle_error"] = str(le)
                yield f"data: {json.dumps(evt)}\n\n"
        except ValueError as e:
            yield f"data: {json.dumps({'type': 'fatal', 'error': str(e), 'status': 400})}\n\n"
        except Exception as e:
            logger.error("host stream failed: %s", e)
            yield f"data: {json.dumps({'type': 'fatal', 'error': str(e), 'status': 500})}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ========================================
# HostStudio Phase 2 — POST /api/composite/generate
# ========================================


@app.post("/api/composite/generate")
async def composite_generate(
    request: Request,
    hostImagePath: str = Form(...),
    productImagePaths: str = Form("[]"),  # JSON array of paths
    backgroundType: str = Form(...),  # "preset"|"upload"|"prompt"
    backgroundPresetId: Optional[str] = Form(None),
    backgroundPresetLabel: Optional[str] = Form(None),
    backgroundUploadPath: Optional[str] = Form(None),
    backgroundPrompt: Optional[str] = Form(None),
    direction: str = Form(""),
    shot: str = Form("bust"),
    angle: str = Form("eye"),
    n: int = Form(4),
    rembg: bool = True,  # query param: ?rembg=false to skip
    temperature: Optional[float] = Form(None),
    seeds: Optional[str] = Form(None),
    imageSize: str = Form("1K"),
):
    """Generate N=4 composite candidates (host + products + background scene) via Gemini.

    Phase 2 — pipeline-v2 Stage 2. See specs/hoststudio-migration/plan.md §248.
    """
    from utils.security import safe_upload_path
    from modules.composite_generator import generate_composite_candidates

    host_resolved = safe_upload_path(hostImagePath)

    try:
        products_raw = json.loads(productImagePaths)
        if not isinstance(products_raw, list):
            raise ValueError("productImagePaths must be a JSON array")
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid productImagePaths: {e}")

    products_resolved = [safe_upload_path(p) for p in products_raw]
    bg_upload_resolved = (
        safe_upload_path(backgroundUploadPath) if backgroundUploadPath else None
    )

    if temperature is not None and not 0.0 <= temperature <= 2.0:
        raise HTTPException(status_code=400, detail=f"temperature must be in [0.0, 2.0], got {temperature}")

    try:
        result = await generate_composite_candidates(
            host_image_path=host_resolved,
            product_image_paths=products_resolved,
            background_type=backgroundType,
            background_preset_id=backgroundPresetId,
            background_preset_label=backgroundPresetLabel,
            background_upload_path=bg_upload_resolved,
            background_prompt=backgroundPrompt,
            direction_ko=direction,
            shot=shot,
            angle=angle,
            n=n,
            rembg_products=rembg,
            temperature=temperature,
            seeds=_parse_seeds_form(seeds),
            image_size=_validate_image_size(imageSize),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    # Lifecycle bookkeeping — tag fresh batch as draft, demote previous
    # selected to is_prev_selected, evict the older prev marker. Augment
    # the response so the frontend can render the 5-tile picker.
    from modules.repositories import studio_host_repo as host_repo
    user = auth_module.get_request_user(request)
    user_id = user["user_id"]
    saved_paths = [c.get("path") for c in (result.get("candidates") or []) if c.get("path")]
    if saved_paths:
        try:
            batch_id = f"batch_{uuid.uuid4().hex[:8]}"
            await host_repo.record_batch(user_id, "2-composite", saved_paths, batch_id)
            await host_repo.cleanup_after_generate(user_id, "2-composite", batch_id)
            state = await host_repo.get_state(user_id, "2-composite")
            result["batch_id"] = batch_id
            result["prev_selected"] = state["prev_selected"]
        except Exception as le:
            logger.error("composite lifecycle bookkeeping failed: %s", le)
            result["lifecycle_error"] = str(le)
    return result


@app.post("/api/composite/generate/stream")
async def composite_generate_stream(
    request: Request,
    hostImagePath: str = Form(...),
    productImagePaths: str = Form("[]"),
    backgroundType: str = Form(...),
    backgroundPresetId: Optional[str] = Form(None),
    backgroundPresetLabel: Optional[str] = Form(None),
    backgroundUploadPath: Optional[str] = Form(None),
    backgroundPrompt: Optional[str] = Form(None),
    direction: str = Form(""),
    shot: str = Form("bust"),
    angle: str = Form("eye"),
    n: int = Form(4),
    rembg: bool = True,
    temperature: Optional[float] = Form(None),
    seeds: Optional[str] = Form(None),
    imageSize: str = Form("1K"),
):
    """SSE variant of /api/composite/generate. Emits {type: "init"} with
    translated direction immediately, then one frame per completed candidate,
    then a terminal {type: "done"}.
    """
    from utils.security import safe_upload_path
    from modules.composite_generator import stream_composite_candidates
    from modules.repositories import studio_host_repo as host_repo

    user = auth_module.get_request_user(request)
    user_id = user["user_id"]
    host_resolved = safe_upload_path(hostImagePath)

    try:
        products_raw = json.loads(productImagePaths)
        if not isinstance(products_raw, list):
            raise ValueError("productImagePaths must be a JSON array")
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid productImagePaths: {e}")

    products_resolved = [safe_upload_path(p) for p in products_raw]
    bg_upload_resolved = (
        safe_upload_path(backgroundUploadPath) if backgroundUploadPath else None
    )

    if temperature is not None and not 0.0 <= temperature <= 2.0:
        raise HTTPException(status_code=400, detail=f"temperature must be in [0.0, 2.0], got {temperature}")

    async def events():
        batch_id = f"batch_{uuid.uuid4().hex[:8]}"
        saved_paths: list = []
        try:
            async for evt in stream_composite_candidates(
                host_image_path=host_resolved,
                product_image_paths=products_resolved,
                background_type=backgroundType,
                background_preset_id=backgroundPresetId,
                background_preset_label=backgroundPresetLabel,
                background_upload_path=bg_upload_resolved,
                background_prompt=backgroundPrompt,
                direction_ko=direction,
                shot=shot,
                angle=angle,
                n=n,
                rembg_products=rembg,
                temperature=temperature,
                seeds=_parse_seeds_form(seeds),
                image_size=_validate_image_size(imageSize),
            ):
                if evt.get("type") == "candidate" and evt.get("path"):
                    saved_paths.append(evt["path"])
                if evt.get("type") == "done" and saved_paths:
                    try:
                        await host_repo.record_batch(user_id, "2-composite", saved_paths, batch_id)
                        await host_repo.cleanup_after_generate(user_id, "2-composite", batch_id)
                        state = await host_repo.get_state(user_id, "2-composite")
                        evt["batch_id"] = batch_id
                        evt["prev_selected"] = state["prev_selected"]
                    except Exception as le:
                        logger.error("composite lifecycle bookkeeping failed: %s", le)
                        evt["lifecycle_error"] = str(le)
                yield f"data: {json.dumps(evt)}\n\n"
        except ValueError as e:
            yield f"data: {json.dumps({'type': 'fatal', 'error': str(e), 'status': 400})}\n\n"
        except Exception as e:
            logger.error("composite stream failed: %s", e)
            yield f"data: {json.dumps({'type': 'fatal', 'error': str(e), 'status': 500})}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ========================================
# HostStudio Phase 1 — Saved Hosts CRUD (PR4: DB-backed)
# ========================================


@app.get("/api/hosts")
async def list_saved_hosts(request: Request):
    """List saved hosts owned by the authenticated user."""
    from modules.repositories import studio_saved_host_repo
    user = auth_module.get_request_user(request)
    items = await studio_saved_host_repo.list_for_user(user["user_id"])
    return {"hosts": items}


@app.post("/api/hosts/save")
async def save_host(
    request: Request,
    source_path: str = Form(...),
    name: str = Form(...),
    meta: Optional[str] = Form(None),  # JSON dict
):
    """Persist a candidate image as a long-lived saved host (PR4: DB-backed)."""
    from pathlib import Path as _Path
    from modules import storage as storage_module
    from modules.repositories import studio_saved_host_repo
    from utils.security import safe_upload_path

    user = auth_module.get_request_user(request)

    # Guard source_path (must be in UPLOADS/OUTPUTS)
    source = safe_upload_path(source_path)
    if not os.path.exists(source):
        raise HTTPException(status_code=404, detail="Source image not found")

    host_id = uuid.uuid4().hex
    storage_key = storage_module.media_store.save_path(
        "hosts", _Path(source), basename=f"{host_id}.png"
    )

    meta_dict = None
    if meta:
        try:
            extra = json.loads(meta)
            if isinstance(extra, dict):
                meta_dict = extra
        except json.JSONDecodeError:
            pass

    try:
        return await studio_saved_host_repo.create(
            user["user_id"],
            host_id=host_id,
            name=name,
            storage_key=storage_key,
            meta=meta_dict,
        )
    except Exception as e:
        # If DB insert fails, clean up the file we just wrote.
        try:
            storage_module.media_store.delete(storage_key)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"Failed to save host: {e}")


@app.delete("/api/hosts/{host_id}")
async def delete_host(host_id: str, request: Request):
    """Remove a saved host (DB row + backing file). Owner-scoped."""
    from modules.repositories import studio_saved_host_repo
    user = auth_module.get_request_user(request)
    # Defensive: host_id must be alphanumeric (UUID hex) to avoid traversal-shaped values.
    if not host_id.isalnum():
        raise HTTPException(status_code=400, detail="Invalid host_id")
    ok = await studio_saved_host_repo.delete(user["user_id"], host_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Host not found")
    return {"message": "deleted", "id": host_id}


# ========================================
# Playlists CRUD (per docs/playlist-feature-plan.md)
# ========================================


def _validate_playlist_id(playlist_id: str) -> None:
    """playlist_id is a 32-char hex uuid (uuid4().hex). Defense-in-depth
    against path-traversal-shaped values arriving via path parameter."""
    if (
        not playlist_id
        or len(playlist_id) != 32
        or not all(c in "0123456789abcdef" for c in playlist_id)
    ):
        raise HTTPException(status_code=400, detail="Invalid playlist_id")


@app.get("/api/playlists")
async def list_playlists(request: Request):
    """List the user's playlists with video counts + the synthetic 미지정 count.
    Sidebar applies alphabetical sort in JS (plan decision #11)."""
    from modules.repositories import studio_playlist_repo
    user = auth_module.get_request_user(request)
    user_id = user["user_id"]
    playlists = await studio_playlist_repo.list_for_user(user_id)
    unassigned = await studio_playlist_repo.unassigned_count(user_id)
    return {"playlists": playlists, "unassigned_count": unassigned}


@app.post("/api/playlists")
async def create_playlist(request: Request, name: str = Form(...)):
    """Create a new playlist. 409 on duplicate name (per-user, NFC+casefold)."""
    from modules.repositories import studio_playlist_repo
    user = auth_module.get_request_user(request)
    try:
        return await studio_playlist_repo.create(user["user_id"], name=name)
    except studio_playlist_repo.DuplicateNameError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except studio_playlist_repo.ReservedNameError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.patch("/api/playlists/{playlist_id}")
async def rename_playlist(playlist_id: str, request: Request, name: str = Form(...)):
    """Rename. 404 if missing/cross-user, 409 on name dup."""
    from modules.repositories import studio_playlist_repo
    _validate_playlist_id(playlist_id)
    user = auth_module.get_request_user(request)
    try:
        out = await studio_playlist_repo.rename(user["user_id"], playlist_id, name=name)
    except studio_playlist_repo.DuplicateNameError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except studio_playlist_repo.ReservedNameError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if out is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return out


@app.delete("/api/playlists/{playlist_id}")
async def delete_playlist(playlist_id: str, request: Request):
    """Delete a playlist; cascades videos to 미지정. 404 if missing/cross-user."""
    from modules.repositories import studio_playlist_repo
    _validate_playlist_id(playlist_id)
    user = auth_module.get_request_user(request)
    ok = await studio_playlist_repo.delete(user["user_id"], playlist_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return {"message": "deleted", "playlist_id": playlist_id}


@app.patch("/api/results/{task_id}/playlist")
async def move_result_to_playlist(
    task_id: str,
    request: Request,
    playlist_id: Optional[str] = Form(None),
):
    """Move a video to a playlist (or empty/null = 미지정). 404 if result
    missing/cross-user OR if playlist_id is non-empty and unknown/cross-user."""
    from modules.repositories import studio_result_repo
    user = auth_module.get_request_user(request)
    if not task_id.isalnum():
        raise HTTPException(status_code=400, detail="Invalid task_id")
    # Empty string from frontends that can't easily send null in a Form body
    # collapses to "unassign". Explicit null-as-text is also normalized.
    if playlist_id in ("", "null", None):
        playlist_id = None
    else:
        _validate_playlist_id(playlist_id)
    try:
        out = await studio_result_repo.set_playlist(user["user_id"], task_id, playlist_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if out is None:
        raise HTTPException(status_code=404, detail="Result not found")
    return {"task_id": task_id, "playlist_id": playlist_id, "message": "updated"}


# ========================================
# HostStudio — Image lifecycle (select / delete composite / delete video)
# ========================================


def _validate_image_id(image_id: str) -> None:
    """Defense-in-depth: image_id is a filename stem like
    `host_abc12345_s10` or `composite_s10_abc12345`. Reject any value
    containing path separators or traversal sequences."""
    if not image_id or "/" in image_id or "\\" in image_id or ".." in image_id:
        raise HTTPException(status_code=400, detail="Invalid image_id")


@app.post("/api/host/select")
async def host_select(request: Request, image_id: str = Form(...)):
    """Mark a Step1 candidate as the user's current selection. Idempotent."""
    from modules.repositories import studio_host_repo as host_repo
    user = auth_module.get_request_user(request)
    _validate_image_id(image_id)
    try:
        rec = await host_repo.select(user["user_id"], "1-host", image_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="Image not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"selected": rec}


@app.post("/api/composite/select")
async def composite_select(request: Request, image_id: str = Form(...)):
    """Mark a Step2 candidate as the user's current selection. Idempotent."""
    from modules.repositories import studio_host_repo as host_repo
    user = auth_module.get_request_user(request)
    _validate_image_id(image_id)
    try:
        rec = await host_repo.select(user["user_id"], "2-composite", image_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="Image not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"selected": rec}


@app.delete("/api/composites/{image_id}")
async def delete_composite(image_id: str, request: Request):
    """Remove a single composite candidate. Refuses `committed` images —
    delete the parent video instead so video_ids bookkeeping stays consistent."""
    from modules.repositories import studio_host_repo as host_repo
    user = auth_module.get_request_user(request)
    _validate_image_id(image_id)
    result = await host_repo.delete_candidate(user["user_id"], "2-composite", image_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="Composite not found")
    if result == "committed":
        raise HTTPException(
            status_code=409,
            detail="Composite is committed to a video; delete the video instead",
        )
    return {"message": "deleted", "id": image_id}


@app.delete("/api/videos/{task_id}")
async def delete_video(task_id: str, request: Request):
    """Remove a generated video. Cascade-deletes any committed step1/step2
    images linked exclusively to this video (see
    studio_host_repo.cascade_delete_by_video). Also drops the result
    manifest and history entry so the dashboard stops surfacing it."""
    from modules.repositories import studio_host_repo as host_repo
    user = auth_module.get_request_user(request)

    if not task_id.replace("-", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid task_id")

    removed_images = await host_repo.cascade_delete_by_video(user["user_id"], task_id)

    # Resolve the video path: prefer in-memory state, then studio_results.
    from modules.repositories import studio_result_repo as _result_repo
    video_path: Optional[str] = None
    state = task_states.get(task_id)
    if state and state.get("output_path"):
        video_path = state["output_path"]
    if not video_path:
        doc = await _result_repo.get(user["user_id"], task_id)
        if doc:
            video_path = doc.get("video_path")
            if not video_path and doc.get("video_storage_key"):
                from modules import storage as _storage
                try:
                    video_path = str(_storage.media_store.local_path_for(doc["video_storage_key"]))
                except ValueError:
                    video_path = None

    deleted_video = False
    if video_path and os.path.exists(video_path):
        try:
            os.unlink(video_path)
            deleted_video = True
        except OSError as e:
            logger.warning("Failed to delete video file %s: %s", video_path, e)

    # Result row (PR5 replacement for outputs/results/<task>.json + history.json).
    await _result_repo.delete(user["user_id"], task_id)

    # In-memory task state (best effort)
    task_states.pop(task_id, None)

    if not deleted_video and not removed_images:
        raise HTTPException(status_code=404, detail="Video not found")
    return {
        "message": "deleted",
        "task_id": task_id,
        "video_deleted": deleted_video,
        "images_removed": removed_images,
    }


# ========================================
# Main
# ========================================

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    # Phase 0 D13: default 127.0.0.1 bind for security;
    # override with HOST=0.0.0.0 env or --host CLI if exposing externally.
    default_host = os.environ.get("HOST", "127.0.0.1")
    parser.add_argument("--host", default=default_host)
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8001")))
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
