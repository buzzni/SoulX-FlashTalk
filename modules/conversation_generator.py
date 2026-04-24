"""
Multi-Agent Conversation Generator
Generates individual video segments for each dialog turn using FlashTalk + ElevenLabs TTS.
"""

import os
import uuid
import hashlib
import logging
import subprocess
import shutil
import time
from typing import Callable, Optional

import config
from modules.dialog_parser import DialogScript, Agent, DialogTurn

IDLE_CACHE_DIR = os.path.join(config.TEMP_DIR, "idle_cache")

logger = logging.getLogger(__name__)


def generate_turn_audio(
    agent: Agent,
    text: str,
    output_dir: str,
    stability: float = 0.5,
    similarity_boost: float = 0.75,
    style: float = 0.0,
) -> str:
    """Generate TTS audio for a single turn using ElevenLabs."""
    from modules.elevenlabs_tts import ElevenLabsTTS

    tts = ElevenLabsTTS(
        api_key=config.ELEVENLABS_API_KEY,
        model_id=config.ELEVENLABS_OPTIONS["model_id"],
    )

    filename = f"turn_{agent.id}_{uuid.uuid4().hex[:8]}.wav"
    output_path = os.path.join(output_dir, filename)

    tts.generate_speech(
        text=text,
        voice_id=agent.voice_id,
        output_path=output_path,
        stability=stability,
        similarity_boost=similarity_boost,
        style=style,
    )

    return output_path


def generate_turn_video(
    pipeline,
    agent: Agent,
    audio_path: str,
    output_dir: str,
    prompt: str,
    seed: int,
    resolution: str = "1280x720",
    progress_callback: Optional[Callable[[float, str], None]] = None,
) -> str:
    """Generate lip-sync video for a single turn using FlashTalk.

    progress_callback(frac, message) — invoked after each chunk with `frac` in
    [0, 1] covering the turn's chunk loop only. Callers map this into the
    overall job progress range (see generate_conversation).
    """
    import numpy as np
    import librosa
    import torch
    import imageio
    from collections import deque
    from flash_talk.inference import get_audio_embedding, run_pipeline, infer_params

    res_parts = resolution.split("x")
    target_h, target_w = int(res_parts[0]), int(res_parts[1])

    # Prepare pipeline params for this agent's face
    pipeline.prepare_params(
        input_prompt=prompt,
        cond_image=agent.face_image,
        target_size=(target_h, target_w),
        frame_num=infer_params['frame_num'],
        motion_frames_num=infer_params['motion_frames_num'],
        sampling_steps=infer_params['sample_steps'],
        seed=seed,
        shift=infer_params['sample_shift'],
        color_correction_strength=infer_params['color_correction_strength'],
    )

    sample_rate = infer_params['sample_rate']
    tgt_fps = infer_params['tgt_fps']
    cached_audio_duration = infer_params['cached_audio_duration']
    frame_num = infer_params['frame_num']
    motion_frames_num = infer_params['motion_frames_num']
    slice_len = frame_num - motion_frames_num

    human_speech_array_all, _ = librosa.load(audio_path, sr=sample_rate, mono=True)

    # Reduce audio intensity for more natural mouth movement
    # FlashTalk uses loudness_norm internally at -23 LUFS; pre-attenuate to target LUFS
    import config as _cfg
    target_lufs = _cfg.FLASHTALK_OPTIONS.get("audio_lufs", -23)
    if target_lufs < -23:
        attenuation_db = target_lufs - (-23)  # negative value
        attenuation_linear = 10.0 ** (attenuation_db / 20.0)
        human_speech_array_all = human_speech_array_all * attenuation_linear
        logger.info(f"  Audio pre-attenuated by {attenuation_db:.1f}dB (target LUFS: {target_lufs})")

    # Stream mode generation
    human_speech_array_slice_len = slice_len * sample_rate // tgt_fps
    cached_audio_length_sum = sample_rate * cached_audio_duration
    audio_end_idx = cached_audio_duration * tgt_fps
    audio_start_idx = audio_end_idx - frame_num

    audio_dq = deque([0.0] * cached_audio_length_sum, maxlen=cached_audio_length_sum)

    remainder = len(human_speech_array_all) % human_speech_array_slice_len
    if remainder > 0:
        pad_length = human_speech_array_slice_len - remainder
        human_speech_array_all = np.concatenate([
            human_speech_array_all,
            np.zeros(pad_length, dtype=human_speech_array_all.dtype)
        ])

    slices = human_speech_array_all.reshape(-1, human_speech_array_slice_len)
    generated_list = []

    total = len(slices)
    for idx, audio_slice in enumerate(slices):
        audio_dq.extend(audio_slice.tolist())
        audio_array = np.array(audio_dq)
        audio_embedding = get_audio_embedding(pipeline, audio_array, audio_start_idx, audio_end_idx)

        torch.cuda.synchronize()
        video = run_pipeline(pipeline, audio_embedding)
        video = video[motion_frames_num:]
        generated_list.append(video.cpu())
        logger.info(f"  Turn chunk {idx}/{total} done")
        if progress_callback:
            progress_callback((idx + 1) / total, f"쇼호스트 움직임 만드는 중 ({idx + 1}/{total})")

    # Save video
    filename = f"turn_{agent.id}_{uuid.uuid4().hex[:8]}.mp4"
    temp_path = os.path.join(output_dir, filename.replace(".mp4", "_temp.mp4"))
    output_path = os.path.join(output_dir, filename)

    with imageio.get_writer(temp_path, format='mp4', mode='I', fps=tgt_fps, codec='h264', ffmpeg_params=['-bf', '0']) as writer:
        for frames in generated_list:
            frames_np = frames.numpy().astype(np.uint8)
            for i in range(frames_np.shape[0]):
                writer.append_data(frames_np[i])

    # Merge audio
    cmd = ['ffmpeg', '-y', '-i', temp_path, '-i', audio_path, '-c:v', 'copy', '-c:a', 'aac', '-shortest', output_path]
    subprocess.run(cmd, check=True, capture_output=True)

    if os.path.exists(temp_path):
        os.remove(temp_path)

    return output_path


def _compute_idle_cache_key(image_path: str, prompt: str, resolution: str, seed: int) -> str:
    """Compute a cache key for idle video based on image content + generation params."""
    h = hashlib.sha256()
    with open(image_path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    h.update(prompt.encode('utf-8'))
    h.update(resolution.encode('utf-8'))
    h.update(str(seed).encode('utf-8'))
    return h.hexdigest()


def _get_cached_idle(cache_key: str) -> Optional[str]:
    """Check if a cached idle video exists and return its path."""
    cached_path = os.path.join(IDLE_CACHE_DIR, f"{cache_key}.mp4")
    if os.path.exists(cached_path) and os.path.getsize(cached_path) > 0:
        return cached_path
    return None


def _save_idle_to_cache(video_path: str, cache_key: str) -> str:
    """Copy generated idle video to cache directory."""
    os.makedirs(IDLE_CACHE_DIR, exist_ok=True)
    cached_path = os.path.join(IDLE_CACHE_DIR, f"{cache_key}.mp4")
    shutil.copy2(video_path, cached_path)
    return cached_path


def generate_idle_audio(duration_sec: float, output_dir: str, amplitude: float = 0.05) -> str:
    """Generate ambient noise WAV for idle video generation.

    Pink noise at moderate amplitude drives FlashTalk's Wav2Vec2 audio encoder
    to produce non-zero embeddings (32 cross-attention tokens per frame),
    which create natural micro-movements (breathing, subtle head shifts, blinks).
    Amplitude 0.05 is tuned to be inaudible but enough to activate the audio pathway.
    """
    filename = f"idle_noise_{uuid.uuid4().hex[:8]}.wav"
    output_path = os.path.join(output_dir, filename)
    cmd = [
        'ffmpeg', '-y', '-f', 'lavfi',
        '-i', 'anoisesrc=d={}:c=pink:r=16000:a={}'.format(duration_sec, amplitude),
        '-acodec', 'pcm_s16le',
        output_path
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return output_path


def generate_conversation(
    dialog: DialogScript,
    pipeline,
    prompt: str,
    seed: int,
    resolution: str = "1280x720",
    layout: str = "split",
    progress_callback: Optional[Callable] = None,
) -> tuple:
    """
    Generate all turn videos for a conversation.

    Returns (segments, idle_videos) where:
      - segments: list of (agent_id, video_path, audio_path) tuples
      - idle_videos: dict of {agent_id: idle_video_path} for split/pip layouts
    """
    output_dir = os.path.join(config.TEMP_DIR, f"conv_{uuid.uuid4().hex[:8]}")
    os.makedirs(output_dir, exist_ok=True)

    total_turns = len(dialog.turns)
    segments = []
    idle_videos = {}

    # Generate idle videos for split/pip layouts (short silence-based clips, looped in compositor)
    # Uses disk cache: same image+prompt+resolution+seed → reuse existing idle video
    # For split layout: inject gaze direction into idle prompt (left agent looks right, right agent looks left)
    if layout in ('split', 'pip'):
        idle_duration = 3.0
        agent_ids = list(dialog.agents.keys())
        for idx, (agent_id, agent) in enumerate(dialog.agents.items()):
            base_prompt = agent.prompt if agent.prompt else prompt

            # Build idle-specific prompt with gaze direction for split layout
            # Build idle-specific prompt with natural movement cues
            # FlashTalk's T5 encoder interprets these as motion intent signals
            idle_prompt = (
                "A person facing forward, smiling gently with a warm pleasant expression. "
                "Natural blinking, subtle breathing movements, and soft facial expressions. "
                "The person maintains eye contact with the camera, looking relaxed and engaged. "
                "Only the foreground person moves naturally, the background remains static."
            )

            # Check disk cache (idle_prompt is part of cache key, so direction-specific caching works automatically)
            cache_key = _compute_idle_cache_key(agent.face_image, idle_prompt, resolution, seed)
            cached_path = _get_cached_idle(cache_key)

            if cached_path:
                idle_videos[agent_id] = cached_path
                logger.info(f"Idle video cache hit for {agent.name} ({cache_key[:12]}...)")
                if progress_callback:
                    progress_callback(
                        "idle_generation",
                        0.03,
                        f"{agent.name} idle 영상 캐시 사용"
                    )
                continue

            # Cache miss: generate new idle video
            if progress_callback:
                progress_callback(
                    "idle_generation",
                    0.03,
                    f"{agent.name} idle 영상 생성 중..."
                )
            silence_path = generate_idle_audio(idle_duration, output_dir)
            idle_path = generate_turn_video(
                pipeline, agent, silence_path, output_dir, idle_prompt, seed, resolution
            )

            # Save to cache
            cached_path = _save_idle_to_cache(idle_path, cache_key)
            idle_videos[agent_id] = cached_path
            logger.info(f"Idle video generated and cached for {agent.name} ({cache_key[:12]}...)")

    for i, turn in enumerate(dialog.turns):
        agent = dialog.agents[turn.agent_id]
        agent_prompt = agent.prompt if agent.prompt else prompt

        if progress_callback:
            progress_callback(
                f"turn_{i+1}_tts",
                0.1 + (i / total_turns) * 0.8,
                f"턴 {i+1}/{total_turns}: {agent.name} TTS 생성 중..."
            )

        # Generate TTS audio
        audio_path = generate_turn_audio(agent, turn.text, output_dir)
        logger.info(f"Turn {i+1}/{total_turns}: TTS done for {agent.name}")

        if progress_callback:
            progress_callback(
                f"turn_{i+1}_video",
                0.1 + ((i + 0.5) / total_turns) * 0.8,
                f"턴 {i+1}/{total_turns}: {agent.name} 비디오 생성 중..."
            )

        # Per-chunk progress inside the turn's video generation, mapped to the
        # second half of this turn's slice of the overall range (TTS occupies
        # the first half). Without this the bar would freeze at the turn-start
        # value for the entire FlashTalk inference — usually the longest phase.
        def _video_chunk_cb(frac: float, msg: str, _i=i) -> None:
            if not progress_callback:
                return
            turn_start = 0.1 + ((_i + 0.5) / total_turns) * 0.8
            turn_end = 0.1 + ((_i + 1.0) / total_turns) * 0.8
            scaled = turn_start + (turn_end - turn_start) * frac
            progress_callback(
                f"turn_{_i+1}_video",
                scaled,
                f"턴 {_i+1}/{total_turns}: {msg}",
            )

        # Generate lip-sync video (use per-agent prompt if set)
        video_path = generate_turn_video(
            pipeline, agent, audio_path, output_dir, agent_prompt, seed, resolution,
            progress_callback=_video_chunk_cb,
        )
        logger.info(f"Turn {i+1}/{total_turns}: Video done for {agent.name}")

        segments.append((turn.agent_id, video_path, audio_path))

    return segments, idle_videos
