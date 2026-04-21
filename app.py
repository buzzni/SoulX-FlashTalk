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

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import uvicorn

import config
from modules.task_queue import task_queue

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

# Create directories
for d in [config.UPLOADS_DIR, config.OUTPUTS_DIR, config.TEMP_DIR, config.EXAMPLES_DIR, config.HOSTS_DIR]:
    os.makedirs(d, exist_ok=True)

# Mount static files (UPLOADS only — NOT PROJECT_ROOT; Phase 0 Critical #1)
app.mount("/static", StaticFiles(directory=config.UPLOADS_DIR), name="static")

# Video history file
VIDEO_HISTORY_FILE = os.path.join(config.OUTPUTS_DIR, "video_history.json")


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
# Video History
# ========================================

def load_video_history() -> list:
    if not os.path.exists(VIDEO_HISTORY_FILE):
        return []
    try:
        with open(VIDEO_HISTORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def save_video_history(history: list):
    try:
        with open(VIDEO_HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump(history, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.error(f"Failed to save history: {e}")


def add_to_history(task_id: str, script_text: str, host_image: str, audio_source: str, output_path: str, generation_time: float = None):
    history = load_video_history()
    file_size = os.path.getsize(output_path) if os.path.exists(output_path) else 0
    history.insert(0, {
        "task_id": task_id,
        "timestamp": datetime.now().isoformat(),
        "script_text": script_text[:100] + "..." if len(script_text) > 100 else script_text,
        "host_image": os.path.basename(host_image),
        "audio_source": audio_source,
        "output_path": output_path,
        "file_size": file_size,
        "video_url": f"/api/videos/{task_id}",
        "generation_time": round(generation_time, 2) if generation_time else None,
    })
    history = history[:100]
    save_video_history(history)


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
    script_text: str = "",
    resolution: str = "1280x720",
    scene_prompt: str = "",
    reference_image_paths: list = None,
):
    """Run SoulX-FlashTalk video generation in background"""
    global pipeline, pipeline_lock

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
                target_h, target_w = int(res_parts[0]), int(res_parts[1])

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

            # Parse resolution (e.g., "1280x720" -> height=1280, width=720)
            res_parts = resolution.split("x")
            target_h, target_w = int(res_parts[0]), int(res_parts[1])
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

                    for idx, chunk in enumerate(chunks):
                        torch.cuda.synchronize()
                        video = run_pipeline(pipeline, chunk)
                        if idx != 0:
                            video = video[motion_frames_num:]
                        generated_list.append(video.cpu())
                        logger.info(f"Chunk {idx}/{len(chunks)} done")

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

                    for idx, audio_slice in enumerate(slices):
                        audio_dq.extend(audio_slice.tolist())
                        audio_array = np.array(audio_dq)
                        audio_embedding = get_audio_embedding(pipeline, audio_array, audio_start_idx, audio_end_idx)

                        torch.cuda.synchronize()
                        video = run_pipeline(pipeline, audio_embedding)
                        video = video[motion_frames_num:]
                        generated_list.append(video.cpu())
                        logger.info(f"Chunk {idx}/{len(slices)} done")

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
            add_to_history(task_id, script_text, host_image, audio_source_label, output_path, generation_time)

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


# ========================================
# Startup
# ========================================

@app.on_event("startup")
async def startup_event():
    global pipeline_lock
    pipeline_lock = asyncio.Lock()

    # Register queue handlers and start worker
    task_queue.register_handler("generate", _queue_generate_handler)
    task_queue.register_handler("conversation", _queue_conversation_handler)
    await task_queue.start()

    logger.info("SoulX-FlashTalk API server started (queue worker active)")


async def _queue_generate_handler(task_id: str, **params):
    """Queue handler that delegates to generate_video_task."""
    await generate_video_task(
        task_id=task_id,
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
    )


async def _queue_conversation_handler(task_id: str, **params):
    """Queue handler that delegates to generate_conversation_task."""
    await generate_conversation_task(
        task_id=task_id,
        dialog_data=params["dialog_data"],
        layout=params["layout"],
        prompt=params["prompt"],
        seed=params["seed"],
        cpu_offload=params["cpu_offload"],
        resolution=params.get("resolution", "1280x720"),
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
):
    """Generate speech using ElevenLabs TTS"""
    if not config.ELEVENLABS_API_KEY:
        raise HTTPException(status_code=400, detail="ElevenLabs API key not configured")

    try:
        from modules.elevenlabs_tts import ElevenLabsTTS
        tts = ElevenLabsTTS(
            api_key=config.ELEVENLABS_API_KEY,
            model_id=config.ELEVENLABS_OPTIONS["model_id"],
        )

        filename = f"tts_{uuid.uuid4().hex[:8]}.wav"
        output_path = os.path.join(config.TEMP_DIR, filename)

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
            ),
        )

        return {"filename": filename, "path": output_path}
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
        },
        label=script_text[:50] if script_text else "Video generation",
    )

    queue_status = await task_queue.get_status()
    position = queue_status["total_pending"]

    return {"task_id": task_id, "message": "Video generation queued", "queue_position": position}


@app.get("/api/progress/{task_id}")
async def progress_stream(task_id: str):
    """SSE endpoint for real-time progress"""
    if task_id not in task_states:
        raise HTTPException(status_code=404, detail="Task not found")

    async def event_generator():
        last_count = 0
        while True:
            state = task_states.get(task_id)
            if not state:
                break

            updates = state["updates"]
            if len(updates) > last_count:
                for u in updates[last_count:]:
                    yield f"data: {json.dumps(u)}\n\n"
                last_count = len(updates)

            if state["stage"] in ["complete", "error"]:
                break

            await asyncio.sleep(0.5)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.get("/api/videos/{task_id}")
async def get_video(task_id: str, download: bool = False):
    """Serve generated video"""
    # Check task state
    state = task_states.get(task_id)
    if state and state.get("output_path") and os.path.exists(state["output_path"]):
        headers = {}
        if download:
            headers["Content-Disposition"] = f'attachment; filename="{os.path.basename(state["output_path"])}"'
        else:
            headers["Content-Disposition"] = "inline"
        return FileResponse(state["output_path"], media_type="video/mp4", headers=headers)

    # Fallback: search history
    history = load_video_history()
    for entry in history:
        if entry["task_id"] == task_id:
            if os.path.exists(entry["output_path"]):
                headers = {"Content-Disposition": "attachment" if download else "inline"}
                return FileResponse(entry["output_path"], media_type="video/mp4", headers=headers)

    raise HTTPException(status_code=404, detail="Video not found")


@app.get("/api/history")
async def get_history(limit: int = 50):
    history = load_video_history()
    return {"total": len(history), "videos": history[:limit]}


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
    resolution: str = "1280x720",
):
    """Run multi-agent conversation video generation in background."""
    global pipeline, pipeline_lock

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

            # Determine composite mode for 2-person split
            res_parts = resolution.split("x")
            target_h, target_w = int(res_parts[0]), int(res_parts[1])
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

            add_to_history(
                task_id,
                script_summary,
                "multi-agent",
                f"conversation:{layout}",
                output_path,
                generation_time,
            )

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


@app.post("/api/generate-conversation")
async def generate_conversation_endpoint(
    dialog_data: str = Form(...),  # JSON string
    layout: str = Form("split"),
    prompt: Optional[str] = Form(None),
    seed: int = Form(9999),
    cpu_offload: bool = Form(True),
    resolution: str = Form("1280x720"),
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
        },
        label=label,
    )

    queue_status = await task_queue.get_status()
    position = queue_status["total_pending"]

    return {"task_id": task_id, "message": "Conversation video generation queued", "queue_position": position}


# ========================================
# Queue Status Endpoints
# ========================================

@app.get("/api/queue")
async def get_queue_status():
    """Get current queue status: running, pending, and recent tasks."""
    return await task_queue.get_status()


@app.delete("/api/queue/{task_id}")
async def cancel_queued_task(task_id: str):
    """Cancel a pending task in the queue."""
    success = await task_queue.cancel_task(task_id)
    if not success:
        raise HTTPException(status_code=404, detail="Task not found or not in pending state")
    # Also update task_states
    if task_id in task_states:
        set_task_error(task_id, "사용자가 작업을 취소했습니다")
    return {"message": "Task cancelled", "task_id": task_id}


@app.get("/api/files/{filename:path}")
async def get_file(filename: str):
    """Serve files from SAFE_ROOTS (UPLOADS/OUTPUTS/EXAMPLES). No PROJECT_ROOT fallback.

    Phase 0 CSO Critical #1 fix. Probes each safe root in order; rejects path
    traversal via utils.security.safe_upload_path realpath containment.
    """
    from utils.security import safe_upload_path

    candidate = None
    for root in config.SAFE_ROOTS:
        probe = os.path.join(root, filename)
        if os.path.exists(probe):
            candidate = probe
            break
    if candidate is None:
        raise HTTPException(status_code=404, detail="File not found")

    # Validate no traversal escape (safe_upload_path raises on any escape)
    filepath = safe_upload_path(candidate)

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
    n: int = Form(4),
):
    """Generate N=4 host candidates via Gemini (Phase 1)."""
    from utils.security import safe_upload_path
    from modules.host_generator import generate_host_candidates

    # Path-traversal guard on all reference images
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
            n=n,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        # All (or too many) Gemini calls failed
        raise HTTPException(status_code=503, detail=str(e))
    return result


# ========================================
# HostStudio Phase 1 — Saved Hosts CRUD
# ========================================


def _host_meta_path(host_id: str) -> str:
    return os.path.join(config.HOSTS_DIR, f"{host_id}.json")


def _host_image_path(host_id: str) -> str:
    return os.path.join(config.HOSTS_DIR, f"{host_id}.png")


@app.get("/api/hosts")
async def list_saved_hosts():
    """List saved hosts (server-persisted). localStorage holds index on client."""
    if not os.path.isdir(config.HOSTS_DIR):
        return {"hosts": []}
    items = []
    for fname in sorted(os.listdir(config.HOSTS_DIR)):
        if not fname.endswith(".json"):
            continue
        host_id = fname[:-5]
        meta_path = _host_meta_path(host_id)
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        items.append(meta)
    return {"hosts": items}


@app.post("/api/hosts/save")
async def save_host(
    source_path: str = Form(...),
    name: str = Form(...),
    meta: Optional[str] = Form(None),  # JSON dict
):
    """Persist a candidate image under HOSTS_DIR (V1 — no auth; protect via REQUIRE_API_KEY)."""
    from utils.security import safe_upload_path

    # Guard source_path (must be in UPLOADS/OUTPUTS)
    source = safe_upload_path(source_path)
    if not os.path.exists(source):
        raise HTTPException(status_code=404, detail="Source image not found")

    host_id = uuid.uuid4().hex
    dst = _host_image_path(host_id)
    import shutil
    shutil.copyfile(source, dst)

    meta_dict = {"id": host_id, "name": name, "path": dst, "url": f"/api/files/outputs/hosts/saved/{host_id}.png"}
    if meta:
        try:
            extra = json.loads(meta)
            if isinstance(extra, dict):
                meta_dict["meta"] = extra
        except json.JSONDecodeError:
            pass
    try:
        with open(_host_meta_path(host_id), "w", encoding="utf-8") as f:
            json.dump(meta_dict, f, ensure_ascii=False, indent=2)
    except OSError as e:
        # Cleanup image if metadata write fails
        try:
            os.unlink(dst)
        except OSError:
            pass
        raise HTTPException(status_code=500, detail=f"Failed to save host: {e}")
    return meta_dict


@app.delete("/api/hosts/{host_id}")
async def delete_host(host_id: str):
    """Remove a saved host and its metadata."""
    # Defensive: host_id must be alphanumeric (UUID hex) to avoid path traversal
    if not host_id.isalnum():
        raise HTTPException(status_code=400, detail="Invalid host_id")
    meta = _host_meta_path(host_id)
    img = _host_image_path(host_id)
    if not os.path.exists(meta):
        raise HTTPException(status_code=404, detail="Host not found")
    try:
        os.unlink(meta)
        if os.path.exists(img):
            os.unlink(img)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Delete failed: {e}")
    return {"message": "deleted", "id": host_id}


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
