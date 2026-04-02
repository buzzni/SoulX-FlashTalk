"""
Video Matting Module
Extracts person from video frames using rembg, returning RGBA frames.
Used for alpha-compositing two FlashTalk-generated agents onto a shared background.
"""

import os
import logging
import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

_rembg_session = None


def _get_session():
    global _rembg_session
    if _rembg_session is None:
        from rembg import new_session
        _rembg_session = new_session("u2net_human_seg")
        logger.info("Video matting rembg session loaded (u2net_human_seg)")
    return _rembg_session


def _boost_alpha(rgba: Image.Image) -> Image.Image:
    """Post-process alpha channel: boost opacity + feather edges for natural blending.

    rembg often outputs weak alpha (150-200) on AI-generated frames.
    This boosts weak alpha to fully opaque, cleans noise, and applies
    Gaussian feathering to edges so the person blends naturally into the background.
    """
    from PIL import ImageFilter

    r, g, b, a = rgba.split()
    a_np = np.array(a, dtype=np.float32)

    # 1) Kill noise: anything below threshold → fully transparent
    a_np[a_np < 30] = 0

    # 2) Boost mid-range: multiply by 2x and clamp to 255
    a_np = np.clip(a_np * 2.0, 0, 255)

    # 3) Strong alpha (>180 after boost) → fully opaque
    a_np[a_np > 180] = 255

    # 4) Edge feathering: Gaussian blur on alpha to soften hard edges
    #    Only blur the edge region, not the interior (preserve sharp person body)
    a_hard = Image.fromarray(a_np.astype(np.uint8), mode="L")
    a_soft = a_hard.filter(ImageFilter.GaussianBlur(radius=3))

    # Blend: keep hard alpha in interior (>200), use soft alpha near edges
    a_hard_np = np.array(a_hard, dtype=np.float32)
    a_soft_np = np.array(a_soft, dtype=np.float32)

    # Interior mask: where hard alpha is fully opaque
    interior = a_hard_np >= 250
    # Use hard alpha for interior, soft alpha for edge region
    a_final = np.where(interior, a_hard_np, a_soft_np)

    a_boosted = Image.fromarray(a_final.astype(np.uint8), mode="L")
    rgba.putalpha(a_boosted)
    return rgba


def release_session():
    global _rembg_session
    _rembg_session = None


def extract_person_frames(video_path: str) -> list:
    """Extract person from each frame of a video.

    Returns list of RGBA PIL Images with background removed.
    """
    import imageio
    from rembg import remove

    session = _get_session()
    reader = imageio.get_reader(video_path)
    rgba_frames = []

    for idx, frame in enumerate(reader):
        img = Image.fromarray(frame).convert("RGB")
        rgba = remove(img, session=session)
        rgba = _boost_alpha(rgba)
        rgba_frames.append(rgba)

        # Debug: save first frame matting result
        if idx == 0:
            debug_dir = os.path.join(os.path.dirname(video_path), "debug_matting")
            os.makedirs(debug_dir, exist_ok=True)
            video_name = os.path.splitext(os.path.basename(video_path))[0]
            rgba.save(os.path.join(debug_dir, f"{video_name}_frame0_rgba.png"))
            rgba.split()[-1].save(os.path.join(debug_dir, f"{video_name}_frame0_alpha.png"))
            logger.info(f"  Debug matting saved to {debug_dir}/")

        if idx % 50 == 0:
            logger.info(f"  Matting frame {idx}...")

    reader.close()
    logger.info(f"Matted {len(rgba_frames)} frames from {os.path.basename(video_path)}")
    return rgba_frames


def composite_onto_background(
    bg_image: Image.Image,
    person_frames_list: list,
    positions: list,
    scales: list,
    fps: float,
    output_path: str,
    audio_paths: list = None,
):
    """Composite multiple person frame sequences onto a shared background.

    Args:
        bg_image: Shared background image (RGB)
        person_frames_list: List of [frames_agent_a, frames_agent_b, ...]
                           Each is a list of RGBA PIL Images
        positions: List of (x_center_ratio, y_bottom_ratio) for each agent
                   e.g., [(0.25, 1.0), (0.75, 1.0)]
        scales: List of scale factors for each agent (relative to bg height)
        fps: Output video FPS
        output_path: Where to save the final mp4
        audio_paths: Optional list of audio file paths to merge
    """
    import imageio
    import subprocess

    bg_w, bg_h = bg_image.size

    # Find the max frame count across all agents
    max_frames = max(len(frames) for frames in person_frames_list)

    temp_path = output_path.replace(".mp4", "_noaudio.mp4")
    writer = imageio.get_writer(temp_path, format='mp4', mode='I', fps=fps,
                                codec='h264', ffmpeg_params=['-bf', '0'])

    for frame_idx in range(max_frames):
        canvas = bg_image.copy().convert("RGBA")

        for agent_idx, (frames, (cx_ratio, cy_ratio), scale) in enumerate(
            zip(person_frames_list, positions, scales)
        ):
            # Get frame (loop if this agent has fewer frames)
            if frame_idx < len(frames):
                person_rgba = frames[frame_idx]
            else:
                person_rgba = frames[-1]  # Hold last frame

            # Scale person relative to background height
            target_h = int(bg_h * scale)
            aspect = person_rgba.width / person_rgba.height
            target_w = int(target_h * aspect)
            person_resized = person_rgba.resize((target_w, target_h), Image.LANCZOS)

            # Position: cx_ratio is center-x, cy_ratio is bottom-y
            paste_x = int(bg_w * cx_ratio) - target_w // 2
            paste_y = int(bg_h * cy_ratio) - target_h

            # Clamp
            paste_x = max(0, min(paste_x, bg_w - target_w))
            paste_y = max(0, min(paste_y, bg_h - target_h))

            canvas.paste(person_resized, (paste_x, paste_y), person_resized)

        # Convert to RGB for video
        frame_rgb = canvas.convert("RGB")
        writer.append_data(np.array(frame_rgb))

        if frame_idx % 50 == 0:
            logger.info(f"  Compositing frame {frame_idx}/{max_frames}...")

    writer.close()
    logger.info(f"Composited {max_frames} frames -> {temp_path}")

    # Merge audio if provided
    if audio_paths:
        _merge_with_audio(temp_path, audio_paths, output_path)
        if os.path.exists(temp_path):
            os.remove(temp_path)
    else:
        os.rename(temp_path, output_path)


def _merge_with_audio(video_path: str, audio_paths: list, output_path: str):
    """Merge video with audio track(s)."""
    import subprocess

    if len(audio_paths) == 1:
        cmd = ['ffmpeg', '-y', '-i', video_path, '-i', audio_paths[0],
               '-c:v', 'copy', '-c:a', 'aac', '-shortest', output_path]
    else:
        # Concatenate audio files first
        temp_audio = output_path.replace(".mp4", "_audio.wav")
        filter_parts = ''.join(f'[{i}:a]' for i in range(len(audio_paths)))
        cmd_audio = ['ffmpeg', '-y']
        for ap in audio_paths:
            cmd_audio.extend(['-i', ap])
        cmd_audio.extend([
            '-filter_complex', f'{filter_parts}concat=n={len(audio_paths)}:v=0:a=1[aout]',
            '-map', '[aout]', temp_audio
        ])
        subprocess.run(cmd_audio, check=True, capture_output=True)

        cmd = ['ffmpeg', '-y', '-i', video_path, '-i', temp_audio,
               '-c:v', 'copy', '-c:a', 'aac', '-shortest', output_path]
        subprocess.run(cmd, check=True, capture_output=True)
        if os.path.exists(temp_audio):
            os.remove(temp_audio)
        return

    subprocess.run(cmd, check=True, capture_output=True)
