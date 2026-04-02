"""
MultiTalk Inference Wrapper
Multi-person video generation using dedicated MultiTalk weights (Wan2.1-I2V-14B-480P + multitalk.safetensors).
Uses dual-axis CFG (text + audio) and deterministic Euler ODE, NOT the FlashTalk distilled sampler.
"""

import math
import os
import uuid
import logging
import subprocess
import time
import yaml
import numpy as np
import torch
import librosa
import imageio
from collections import deque

logger = logging.getLogger(__name__)

# MultiTalk-specific inference params
_multitalk_infer_params = None


def get_multitalk_infer_params():
    global _multitalk_infer_params
    if _multitalk_infer_params is None:
        params_path = os.path.join(
            os.path.dirname(__file__), "..", "flash_talk", "configs", "multitalk_infer_params.yaml"
        )
        with open(params_path, "r") as f:
            _multitalk_infer_params = yaml.safe_load(f)
    return _multitalk_infer_params


def get_multitalk_pipeline(ckpt_dir, wav2vec_dir, cpu_offload=False):
    """Load a MultiTalk pipeline with proper MultiTalk weights."""
    from flash_talk.infinite_talk.configs import multitalk_14B
    from flash_talk.src.pipeline.flash_talk_pipeline import FlashTalkPipeline
    from flash_talk.src.distributed.usp_device import get_device, get_parallel_degree

    cfg = multitalk_14B
    ulysses_degree, ring_degree = get_parallel_degree(1, cfg.num_heads)
    device = get_device(ulysses_degree, ring_degree)

    logger.info(f"Loading MultiTalk pipeline from {ckpt_dir}")
    pipeline = FlashTalkPipeline(
        config=cfg,
        checkpoint_dir=ckpt_dir,
        wav2vec_dir=wav2vec_dir,
        device=device,
        use_usp=False,
        cpu_offload=cpu_offload,
    )
    logger.info("MultiTalk pipeline loaded successfully")
    return pipeline


def generate_ref_target_masks(target_h: int, target_w: int, num_people: int = 2) -> torch.Tensor:
    """Generate binary masks splitting the image into left/right halves."""
    masks = torch.zeros(num_people, target_h, target_w)
    if num_people == 2:
        half_w = target_w // 2
        masks[0, :, :half_w] = 1.0
        masks[1, :, half_w:] = 1.0
    else:
        masks[0, :, :] = 1.0
    return masks


def get_multi_audio_embedding(pipeline, audio_arrays: list, audio_start_idx: int, audio_end_idx: int):
    """Process multiple audio streams and stack along batch dimension."""
    from flash_talk.inference import get_audio_embedding
    embeddings = []
    for audio_array in audio_arrays:
        emb = get_audio_embedding(pipeline, audio_array, audio_start_idx, audio_end_idx)
        embeddings.append(emb)
    return torch.cat(embeddings, dim=0)


def generate_silence_audio(duration_sec: float, sample_rate: int = 16000) -> np.ndarray:
    """Generate very low amplitude pink noise (avoids NaN in loudness_norm)."""
    num_samples = int(duration_sec * sample_rate)
    white = np.random.randn(num_samples).astype(np.float32)
    pink = np.cumsum(white)
    pink = pink - np.mean(pink)
    max_val = np.max(np.abs(pink)) + 1e-8
    pink = pink / max_val * 0.005
    return pink.astype(np.float32)


# ========================================
# MultiTalk-specific prepare & generate
# ========================================

def multitalk_prepare_params(pipeline, input_prompt, cond_image, target_size,
                              frame_num, motion_frames_num, sampling_steps,
                              seed, shift, color_correction_strength,
                              ref_target_masks=None):
    """Prepare params for MultiTalk, including null conditioning contexts for CFG."""
    from flash_talk.src.pipeline.flash_talk_pipeline import timestep_transform
    from flash_talk.infinite_talk.utils.multitalk_utils import resize_and_centercrop
    from PIL import Image

    # Encode positive prompt
    if pipeline.cpu_offload:
        pipeline.text_encoder.model.to(pipeline.device)
    context = pipeline.text_encoder([input_prompt], pipeline.device)[0]
    context_null = pipeline.text_encoder([pipeline.sample_neg_prompt], pipeline.device)[0]
    if pipeline.cpu_offload:
        pipeline.text_encoder.model.cpu()
        torch.cuda.empty_cache()

    pipeline.frame_num = frame_num
    pipeline.motion_frames_num = motion_frames_num
    pipeline.target_h, pipeline.target_w = target_size
    pipeline.lat_h = pipeline.target_h // pipeline.vae_stride[1]
    pipeline.lat_w = pipeline.target_w // pipeline.vae_stride[2]

    if isinstance(cond_image, str):
        cond_image = Image.open(cond_image).convert("RGB")
    cond_image_tensor = resize_and_centercrop(cond_image, (pipeline.target_h, pipeline.target_w)).to(
        dtype=pipeline.param_dtype, device=pipeline.device
    )
    cond_image_tensor = (cond_image_tensor / 255 - 0.5) * 2
    pipeline.cond_image_tensor = cond_image_tensor

    pipeline.color_correction_strength = color_correction_strength
    pipeline.original_color_reference = None
    if color_correction_strength > 0.0:
        pipeline.original_color_reference = cond_image_tensor.clone()

    # CLIP
    if pipeline.cpu_offload:
        pipeline.clip.model.to(pipeline.device)
    clip_context = pipeline.clip.visual(cond_image_tensor[:, :, -1:, :, :]).to(pipeline.param_dtype)
    if pipeline.cpu_offload:
        pipeline.clip.model.cpu()
        torch.cuda.empty_cache()

    # VAE encode
    video_frames = torch.zeros(
        1, cond_image_tensor.shape[1], frame_num - cond_image_tensor.shape[2],
        pipeline.target_h, pipeline.target_w
    ).to(dtype=pipeline.param_dtype, device=pipeline.device)
    padding_frames = torch.concat([cond_image_tensor, video_frames], dim=2)

    if pipeline.cpu_offload:
        pipeline.vae.model.to(pipeline.device)
    y = pipeline.vae.encode(padding_frames)
    common_y = y.unsqueeze(0).to(pipeline.param_dtype)

    # Mask
    msk = torch.ones(1, frame_num, pipeline.lat_h, pipeline.lat_w, device=pipeline.device)
    msk[:, 1:] = 0
    msk = torch.concat([
        torch.repeat_interleave(msk[:, 0:1], repeats=4, dim=1), msk[:, 1:]
    ], dim=1)
    msk = msk.view(1, msk.shape[1] // 4, 4, pipeline.lat_h, pipeline.lat_w)
    msk = msk.transpose(1, 2).to(pipeline.param_dtype)
    y = torch.concat([msk, common_y], dim=1)

    max_seq_len = ((frame_num - 1) // pipeline.vae_stride[0] + 1) * pipeline.lat_h * pipeline.lat_w // (
        pipeline.patch_size[1] * pipeline.patch_size[2]
    )
    max_seq_len = int(math.ceil(max_seq_len / pipeline.sp_size)) * pipeline.sp_size

    pipeline.generator = torch.Generator(device=pipeline.device).manual_seed(seed)

    # Timesteps
    timesteps = list(np.linspace(pipeline.num_timesteps, 1, sampling_steps, dtype=np.float32))
    timesteps.append(0.)
    timesteps = [torch.tensor([t], device=pipeline.device) for t in timesteps]
    timesteps = [timestep_transform(t, shift=shift, num_timesteps=pipeline.num_timesteps) for t in timesteps]
    pipeline.timesteps = timesteps

    # Full conditioning
    pipeline.arg_c = {
        'context': [context],
        'clip_fea': clip_context,
        'seq_len': max_seq_len,
        'y': y,
        'ref_target_masks': ref_target_masks.to(pipeline.device) if ref_target_masks is not None else None,
    }

    # Null-text conditioning (for CFG: audio only, no text guidance)
    pipeline.arg_null_text = {
        'context': [context_null],
        'clip_fea': clip_context,
        'seq_len': max_seq_len,
        'y': y,
        'ref_target_masks': ref_target_masks.to(pipeline.device) if ref_target_masks is not None else None,
    }

    pipeline.latent_motion_frames = pipeline.vae.encode(pipeline.cond_image_tensor)

    if pipeline.cpu_offload:
        pipeline.vae.model.cpu()
        torch.cuda.empty_cache()


@torch.no_grad()
def multitalk_generate(pipeline, audio_embedding, is_first_chunk=True,
                       text_guide_scale=5.0, audio_guide_scale=4.0):
    """MultiTalk generate with dual-axis CFG + deterministic Euler ODE.

    Matches official MeiGen-AI/MultiTalk wan/multitalk.py generate():
    - 3 forward passes: full cond, drop-text, fully uncond
    - Null audio uses [-1:] to reduce human_num to 1
    - Motion frames injected only for non-first chunks, re-noised each step
    - Euler ODE: latent += noise_pred * dt
    """
    from flash_talk.infinite_talk.utils.multitalk_utils import match_and_blend_colors_torch

    if pipeline.cpu_offload:
        pipeline.model.to(pipeline.device)

    audio_embedding = audio_embedding.to(pipeline.device)

    # Null audio: zeros with batch dim reduced to 1 (official: torch.zeros_like(audio_embs)[-1:])
    # This makes human_num=1 for unconditioned passes
    null_audio = torch.zeros_like(audio_embedding)[-1:]

    # Prepare arg_null (fully unconditional: null text + null audio)
    # Separate dict to avoid mutating arg_null_text during iteration
    arg_null = {
        'context': pipeline.arg_null_text['context'],
        'clip_fea': pipeline.arg_null_text['clip_fea'],
        'seq_len': pipeline.arg_null_text['seq_len'],
        'y': pipeline.arg_null_text['y'],
        'ref_target_masks': pipeline.arg_null_text['ref_target_masks'],
        'audio': null_audio,
    }

    # Also prepare arg_null_audio (text + null audio) — needed if text_guide_scale == 1.0
    arg_null_audio = {
        'context': pipeline.arg_c['context'],
        'clip_fea': pipeline.arg_c['clip_fea'],
        'seq_len': pipeline.arg_c['seq_len'],
        'y': pipeline.arg_c['y'],
        'ref_target_masks': pipeline.arg_c['ref_target_masks'],
        'audio': null_audio,
    }

    # Initial noise
    latent = torch.randn(
        16, (pipeline.frame_num - 1) // 4 + 1,
        pipeline.lat_h, pipeline.lat_w,
        dtype=pipeline.param_dtype,
        device=pipeline.device,
        generator=pipeline.generator,
    )

    # Motion frame injection: only for non-first chunks (official behavior)
    motion_frames_latent = pipeline.latent_motion_frames.to(pipeline.device)
    T_m = motion_frames_latent.shape[1]

    if not is_first_chunk:
        # Inject noised motion frames at initial noise level
        motion_noise = torch.randn_like(motion_frames_latent).contiguous()
        noised_motion = _add_noise(motion_frames_latent, motion_noise,
                                   pipeline.timesteps[0], pipeline.num_timesteps)
        latent[:, :T_m] = noised_motion

    for i in range(len(pipeline.timesteps) - 1):
        timestep = pipeline.timesteps[i]
        latent_input = [latent]

        torch.cuda.synchronize()
        step_start = time.time()

        # Pass 1: Full conditioning (text + audio)
        pipeline.arg_c['audio'] = audio_embedding
        noise_pred_cond = pipeline.model(latent_input, t=timestep, **pipeline.arg_c)[0]

        if math.isclose(text_guide_scale, 1.0):
            # 2-pass mode: only audio guidance
            noise_pred_drop_audio = pipeline.model(latent_input, t=timestep, **arg_null_audio)[0]
            noise_pred = noise_pred_drop_audio + audio_guide_scale * (noise_pred_cond - noise_pred_drop_audio)
        else:
            # 3-pass mode: dual-axis CFG (text + audio)
            pipeline.arg_null_text['audio'] = audio_embedding
            noise_pred_drop_text = pipeline.model(latent_input, t=timestep, **pipeline.arg_null_text)[0]

            noise_pred_uncond = pipeline.model(latent_input, t=timestep, **arg_null)[0]

            noise_pred = (
                noise_pred_uncond
                + text_guide_scale * (noise_pred_cond - noise_pred_drop_text)
                + audio_guide_scale * (noise_pred_drop_text - noise_pred_uncond)
            )

        noise_pred = -noise_pred

        torch.cuda.synchronize()
        step_end = time.time()
        if i % 10 == 0:
            print(f'[multitalk_generate] step {i}/{len(pipeline.timesteps)-1}: {step_end - step_start:.2f}s')

        # Euler ODE step
        dt = (pipeline.timesteps[i] - pipeline.timesteps[i + 1]) / pipeline.num_timesteps
        latent = latent + noise_pred * dt[:, None, None, None]

        # Re-inject motion frames at next noise level (non-first chunks only)
        if not is_first_chunk:
            motion_noise = torch.randn_like(motion_frames_latent).contiguous()
            noised_motion = _add_noise(motion_frames_latent, motion_noise,
                                       pipeline.timesteps[i + 1], pipeline.num_timesteps)
            latent[:, :T_m] = noised_motion

    if pipeline.cpu_offload:
        pipeline.model.cpu()
        torch.cuda.empty_cache()
        pipeline.vae.model.to(pipeline.device)

    # Decode
    torch.cuda.synchronize()
    decode_start = time.time()
    videos = pipeline.vae.decode(latent.to(pipeline.param_dtype))
    torch.cuda.synchronize()
    print(f'[multitalk_generate] decode: {time.time() - decode_start:.2f}s')

    # Color correction
    if pipeline.color_correction_strength > 0.0:
        videos = match_and_blend_colors_torch(videos, pipeline.original_color_reference, pipeline.color_correction_strength)

    # Update motion frames for next chunk
    cond_frame = videos[:, :, -pipeline.motion_frames_num:].to(pipeline.device)
    pipeline.latent_motion_frames = pipeline.vae.encode(cond_frame)

    if pipeline.cpu_offload:
        pipeline.vae.model.cpu()
        torch.cuda.empty_cache()

    return videos[0].to(torch.float32)


def _add_noise(original_samples, noise, timestep, num_timesteps):
    """Flow-matching linear noise schedule: (1-t)*x + t*noise"""
    t = timestep.float() / num_timesteps
    t = t.view(t.shape + (1,) * (len(noise.shape) - 1))
    return (1 - t) * original_samples + t * noise


# ========================================
# Turn & Conversation Generation
# ========================================

def generate_multitalk_turn_video(
    pipeline,
    full_image_path: str,
    speaker_audio_path: str,
    speaker_side: int,
    output_dir: str,
    prompt: str,
    seed: int,
    target_h: int,
    target_w: int,
) -> str:
    """Generate a single turn video with both people visible, speaker's lips moving."""
    infer_params = get_multitalk_infer_params()
    sample_rate = infer_params['sample_rate']
    tgt_fps = infer_params['tgt_fps']
    cached_audio_duration = infer_params['cached_audio_duration']
    frame_num = infer_params['frame_num']
    motion_frames_num = infer_params['motion_frames_num']
    slice_len = frame_num - motion_frames_num

    # Prepare ref_target_masks
    masks = generate_ref_target_masks(target_h, target_w, num_people=2)

    # Prepare pipeline with MultiTalk-specific params (includes null contexts for CFG)
    multitalk_prepare_params(
        pipeline,
        input_prompt=prompt,
        cond_image=full_image_path,
        target_size=(target_h, target_w),
        frame_num=frame_num,
        motion_frames_num=motion_frames_num,
        sampling_steps=infer_params['sample_steps'],
        seed=seed,
        shift=infer_params['sample_shift'],
        color_correction_strength=infer_params['color_correction_strength'],
        ref_target_masks=masks,
    )

    # Load speaker audio
    speaker_audio, _ = librosa.load(speaker_audio_path, sr=sample_rate, mono=True)
    speaker_duration = len(speaker_audio) / sample_rate
    silent_audio = generate_silence_audio(speaker_duration, sample_rate)

    # Assign audio to correct sides: [left_audio, right_audio]
    if speaker_side == 0:
        audio_arrays_all = [speaker_audio, silent_audio]
    else:
        audio_arrays_all = [silent_audio, speaker_audio]

    # Stream mode generation
    human_speech_array_slice_len = slice_len * sample_rate // tgt_fps
    cached_audio_length_sum = sample_rate * cached_audio_duration
    audio_end_idx = cached_audio_duration * tgt_fps
    audio_start_idx = audio_end_idx - frame_num

    audio_dqs = [
        deque([0.0] * cached_audio_length_sum, maxlen=cached_audio_length_sum)
        for _ in range(2)
    ]

    # Pad audio to be divisible by slice length
    max_len = max(len(a) for a in audio_arrays_all)
    remainder = max_len % human_speech_array_slice_len
    if remainder > 0:
        pad_length = human_speech_array_slice_len - remainder
    else:
        pad_length = 0
    target_len = max_len + pad_length
    audio_arrays_all = [
        np.concatenate([a, np.zeros(target_len - len(a), dtype=a.dtype)])
        for a in audio_arrays_all
    ]

    num_slices = len(audio_arrays_all[0]) // human_speech_array_slice_len
    generated_list = []

    for idx in range(num_slices):
        start = idx * human_speech_array_slice_len
        end = start + human_speech_array_slice_len

        person_arrays = []
        for p in range(2):
            audio_slice = audio_arrays_all[p][start:end]
            audio_dqs[p].extend(audio_slice.tolist())
            person_arrays.append(np.array(audio_dqs[p]))

        audio_embedding = get_multi_audio_embedding(
            pipeline, person_arrays, audio_start_idx, audio_end_idx
        )

        # Use MultiTalk-specific generate with CFG + Euler ODE
        sample = multitalk_generate(pipeline, audio_embedding, is_first_chunk=(idx == 0))
        sample_frames = (((sample + 1) / 2).permute(1, 2, 3, 0).clip(0, 1) * 255).contiguous()
        if idx == 0:
            generated_list.append(sample_frames.cpu())
        else:
            video = sample_frames[motion_frames_num:]
            generated_list.append(video.cpu())
        logger.info(f"  MultiTalk chunk {idx+1}/{num_slices} done")

    # Save video
    filename = f"multitalk_{uuid.uuid4().hex[:8]}.mp4"
    temp_path = os.path.join(output_dir, filename.replace(".mp4", "_temp.mp4"))
    output_path = os.path.join(output_dir, filename)

    with imageio.get_writer(temp_path, format='mp4', mode='I', fps=tgt_fps,
                            codec='h264', ffmpeg_params=['-bf', '0']) as writer:
        for frames in generated_list:
            frames_np = frames.numpy().astype(np.uint8)
            for i in range(frames_np.shape[0]):
                writer.append_data(frames_np[i])

    # Merge with speaker audio
    cmd = ['ffmpeg', '-y', '-i', temp_path, '-i', speaker_audio_path,
           '-c:v', 'copy', '-c:a', 'aac', '-shortest', output_path]
    subprocess.run(cmd, check=True, capture_output=True)

    if os.path.exists(temp_path):
        os.remove(temp_path)

    return output_path


def generate_conversation_multitalk(
    dialog,
    pipeline,
    full_image_path: str,
    prompt: str,
    seed: int,
    resolution: str = "1280x720",
    progress_callback=None,
) -> list:
    """Generate all turn videos using MultiTalk (both people in each frame)."""
    from modules.conversation_generator import generate_turn_audio

    output_dir = os.path.join("temp", f"conv_{uuid.uuid4().hex[:8]}")
    os.makedirs(output_dir, exist_ok=True)

    res_parts = resolution.split("x")
    target_h, target_w = int(res_parts[0]), int(res_parts[1])

    # For 2-person split, ALWAYS use landscape bucket to give each person enough pixels.
    # Portrait output (1280x720) has 2 people in one frame → need wide generation.
    # (448, 832) = 832px wide → ~416px per person (vs FlashTalk's 448px per person).
    # (384, 1024) = 1024px wide → ~512px per person (better quality, more VRAM).
    num_agents = len(dialog.agents)
    if num_agents >= 2:
        # Landscape: prioritize width for side-by-side people
        mt_target_h, mt_target_w = 384, 1024
    else:
        # Single person: match output aspect ratio
        aspect_ratio = target_h / target_w
        buckets_480p = {
            0.26: (320, 1216), 0.38: (384, 1024), 0.50: (448, 896), 0.67: (512, 768),
            0.82: (576, 704), 1.00: (640, 640), 1.22: (704, 576), 1.50: (768, 512),
            1.86: (832, 448), 2.00: (896, 448), 2.50: (960, 384), 2.83: (1088, 384),
        }
        closest_ratio = min(buckets_480p.keys(), key=lambda r: abs(r - aspect_ratio))
        mt_target_h, mt_target_w = buckets_480p[closest_ratio]
    logger.info(f"MultiTalk target: {mt_target_w}x{mt_target_h} ({num_agents} people)")

    agent_ids = list(dialog.agents.keys())
    total_turns = len(dialog.turns)
    segments = []

    for i, turn in enumerate(dialog.turns):
        agent = dialog.agents[turn.agent_id]
        speaker_side = agent_ids.index(turn.agent_id)

        if progress_callback:
            progress_callback(
                f"turn_{i+1}_tts",
                0.1 + (i / total_turns) * 0.8,
                f"턴 {i+1}/{total_turns}: {agent.name} TTS 생성 중..."
            )

        audio_path = generate_turn_audio(agent, turn.text, output_dir)

        if progress_callback:
            progress_callback(
                f"turn_{i+1}_video",
                0.1 + ((i + 0.5) / total_turns) * 0.8,
                f"턴 {i+1}/{total_turns}: MultiTalk 영상 생성 중... (40 steps × 3 passes)"
            )

        video_path = generate_multitalk_turn_video(
            pipeline=pipeline,
            full_image_path=full_image_path,
            speaker_audio_path=audio_path,
            speaker_side=speaker_side,
            output_dir=output_dir,
            prompt=prompt,
            seed=seed,
            target_h=mt_target_h,
            target_w=mt_target_w,
        )
        logger.info(f"Turn {i+1}/{total_turns}: MultiTalk video done for {agent.name}")

        segments.append((None, video_path, audio_path))

    return segments
