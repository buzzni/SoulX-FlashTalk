"""
Conversation Compositor
Combines individual turn videos into a final conversation video with layout effects.
Supports split (side-by-side), switch (full-screen swap), and pip (picture-in-picture) layouts.
"""

import os
import subprocess
import logging

logger = logging.getLogger(__name__)


def get_video_duration(video_path: str) -> float:
    """Get video duration in seconds using ffprobe."""
    cmd = [
        'ffprobe', '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        video_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return float(result.stdout.strip())


def get_last_frame(video_path: str, output_path: str):
    """Extract last frame from video."""
    cmd = [
        'ffmpeg', '-y', '-sseof', '-0.1', '-i', video_path,
        '-update', '1', '-q:v', '2', output_path
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _get_inactive_input(agent_id, idle_videos, ref_frames, fallback_agent_id):
    """Get ffmpeg input args for the inactive agent (idle video or frozen frame fallback)."""
    if idle_videos and agent_id in idle_videos:
        return ['-stream_loop', '-1', '-i', idle_videos[agent_id]]
    ref = ref_frames.get(agent_id, ref_frames.get(fallback_agent_id))
    return ['-loop', '1', '-i', ref]



def composite_split(
    segments: list,
    agents: dict,
    output_path: str,
    resolution: str = "1280x720",
    idle_videos: dict = None,
):
    """
    Split layout: side-by-side view of two agents.
    Uses hstack + thin gaussian blur strip at the center seam to soften the boundary.
    """
    res_parts = resolution.split("x")
    out_h, out_w = int(res_parts[0]), int(res_parts[1])
    half_w = out_w // 2
    blur_w = max(out_w // 36, 16)  # ~20px thin blur strip
    blur_x = half_w - blur_w // 2

    temp_dir = os.path.dirname(segments[0][1])
    turn_videos = []

    agent_ids = list(agents.keys())
    agent_a, agent_b = agent_ids[0], agent_ids[1]

    ref_frames = {}
    for agent_id, video_path, _ in segments:
        if agent_id not in ref_frames:
            ref_frame_path = os.path.join(temp_dir, f"ref_{agent_id}.jpg")
            cmd = [
                'ffmpeg', '-y', '-i', video_path,
                '-vframes', '1', '-q:v', '2', ref_frame_path
            ]
            subprocess.run(cmd, check=True, capture_output=True)
            ref_frames[agent_id] = ref_frame_path

    for i, (agent_id, video_path, audio_path) in enumerate(segments):
        duration = get_video_duration(video_path)
        other_id = agent_b if agent_id == agent_a else agent_a

        last_frame_path = os.path.join(temp_dir, f"lastframe_{agent_id}_{i}.jpg")
        get_last_frame(video_path, last_frame_path)

        other_input = _get_inactive_input(other_id, idle_videos, ref_frames, agent_a)
        turn_output = os.path.join(temp_dir, f"split_turn_{i}.mp4")

        # hstack two center-cropped halves, then blur thin strip at seam
        filt = (
            f'[0:v]scale={half_w}:{out_h}:force_original_aspect_ratio=increase,crop={half_w}:{out_h}[left];'
            f'[1:v]scale={half_w}:{out_h}:force_original_aspect_ratio=increase,crop={half_w}:{out_h}[right];'
            f'[left][right]hstack=inputs=2[stacked];'
            f'[stacked]split[main][bsrc];'
            f'[bsrc]crop={blur_w}:{out_h}:{blur_x}:0,gblur=sigma=8[blr];'
            f'[main][blr]overlay=x={blur_x}:y=0[vout]'
        )

        if agent_id == agent_a:
            cmd = [
                'ffmpeg', '-y', '-i', video_path, *other_input,
                '-filter_complex', filt,
                '-map', '[vout]', '-map', '0:a',
                '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac',
                '-t', str(duration), '-shortest', turn_output
            ]
        else:
            cmd = [
                'ffmpeg', '-y', *other_input, '-i', video_path,
                '-filter_complex', filt,
                '-map', '[vout]', '-map', '1:a',
                '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac',
                '-t', str(duration), '-shortest', turn_output
            ]

        subprocess.run(cmd, check=True, capture_output=True)
        turn_videos.append(turn_output)
        ref_frames[agent_id] = last_frame_path

    _concat_videos(turn_videos, output_path, temp_dir)


def composite_switch(
    segments: list,
    agents: dict,
    output_path: str,
    resolution: str = "1280x720",
    crossfade_duration: float = 0.3,
):
    """
    Switch layout: full-screen active speaker with crossfade transitions between turns.
    """
    res_parts = resolution.split("x")
    out_h, out_w = int(res_parts[0]), int(res_parts[1])

    temp_dir = os.path.dirname(segments[0][1])
    turn_videos = []

    for i, (agent_id, video_path, audio_path) in enumerate(segments):
        turn_output = os.path.join(temp_dir, f"switch_turn_{i}.mp4")
        cmd = [
            'ffmpeg', '-y', '-i', video_path,
            '-vf', f'scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h}',
            '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac',
            turn_output
        ]
        subprocess.run(cmd, check=True, capture_output=True)
        turn_videos.append(turn_output)

    if len(turn_videos) <= 1:
        if turn_videos:
            subprocess.run(['cp', turn_videos[0], output_path], check=True)
        return

    # Use crossfade transitions between turns
    _concat_with_crossfade(turn_videos, output_path, temp_dir, crossfade_duration)


def composite_pip(
    segments: list,
    agents: dict,
    output_path: str,
    resolution: str = "1280x720",
    idle_videos: dict = None,
):
    """
    PiP layout: active speaker full-screen, inactive speaker in small corner overlay.
    Uses idle video for the sub-window when available, frozen frame as fallback.
    """
    res_parts = resolution.split("x")
    out_h, out_w = int(res_parts[0]), int(res_parts[1])
    pip_w = out_w // 4
    pip_h = out_h // 4

    temp_dir = os.path.dirname(segments[0][1])
    turn_videos = []

    agent_ids = list(agents.keys())
    agent_a, agent_b = agent_ids[0], agent_ids[1]

    # Reference frames as fallback
    ref_frames = {}
    for agent_id, video_path, _ in segments:
        if agent_id not in ref_frames:
            ref_frame_path = os.path.join(temp_dir, f"pip_ref_{agent_id}.jpg")
            cmd = ['ffmpeg', '-y', '-i', video_path, '-vframes', '1', '-q:v', '2', ref_frame_path]
            subprocess.run(cmd, check=True, capture_output=True)
            ref_frames[agent_id] = ref_frame_path

    for i, (agent_id, video_path, audio_path) in enumerate(segments):
        duration = get_video_duration(video_path)
        other_id = agent_b if agent_id == agent_a else agent_a

        # Get inactive agent input (idle video or frozen frame)
        other_input = _get_inactive_input(other_id, idle_videos, ref_frames, agent_a)

        turn_output = os.path.join(temp_dir, f"pip_turn_{i}.mp4")

        margin = 10
        cmd = [
            'ffmpeg', '-y',
            '-i', video_path,
            *other_input,
            '-filter_complex',
            f'[0:v]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h}[main];'
            f'[1:v]scale={pip_w}:{pip_h}:force_original_aspect_ratio=increase,crop={pip_w}:{pip_h},'
            f'drawbox=x=0:y=0:w={pip_w}:h={pip_h}:color=white@0.5:t=2[pip];'
            f'[main][pip]overlay=x={out_w - pip_w - margin}:y={out_h - pip_h - margin}[vout]',
            '-map', '[vout]', '-map', '0:a',
            '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac',
            '-t', str(duration), '-shortest',
            turn_output
        ]
        subprocess.run(cmd, check=True, capture_output=True)
        turn_videos.append(turn_output)

        # Update reference frame (fallback)
        last_frame_path = os.path.join(temp_dir, f"pip_lastframe_{agent_id}_{i}.jpg")
        get_last_frame(video_path, last_frame_path)
        ref_frames[agent_id] = last_frame_path

    _concat_videos(turn_videos, output_path, temp_dir)


def _concat_videos(video_paths: list, output_path: str, temp_dir: str):
    """Concatenate videos using ffmpeg concat demuxer (hard cut)."""
    concat_list = os.path.join(temp_dir, "concat_list.txt")
    with open(concat_list, "w") as f:
        for vp in video_paths:
            f.write(f"file '{vp}'\n")

    cmd = [
        'ffmpeg', '-y', '-f', 'concat', '-safe', '0',
        '-i', concat_list,
        '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac',
        output_path
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    logger.info(f"Composited {len(video_paths)} turns -> {output_path}")


def _concat_with_crossfade(video_paths: list, output_path: str, temp_dir: str, crossfade_duration: float = 0.3):
    """Concatenate videos with crossfade transitions using xfade + acrossfade filters."""
    n = len(video_paths)
    if n <= 1:
        if video_paths:
            subprocess.run(['cp', video_paths[0], output_path], check=True)
        return

    durations = [get_video_duration(vp) for vp in video_paths]
    cf = crossfade_duration

    # Ensure crossfade doesn't exceed any clip duration
    min_dur = min(durations)
    if cf >= min_dur:
        cf = max(min_dur * 0.3, 0.1)

    inputs = []
    for vp in video_paths:
        inputs.extend(['-i', vp])

    v_parts = []
    a_parts = []
    cumulative_dur = durations[0]

    for i in range(1, n):
        prev_v = f'[0:v]' if i == 1 else f'[xv{i-1}]'
        out_v = f'[xv{i}]' if i < n - 1 else '[vout]'
        prev_a = f'[0:a]' if i == 1 else f'[xa{i-1}]'
        out_a = f'[xa{i}]' if i < n - 1 else '[aout]'

        offset = max(cumulative_dur - cf, 0)
        v_parts.append(f'{prev_v}[{i}:v]xfade=transition=fade:duration={cf}:offset={offset}{out_v}')
        a_parts.append(f'{prev_a}[{i}:a]acrossfade=d={cf}{out_a}')

        cumulative_dur += durations[i] - cf

    filter_complex = ';'.join(v_parts + a_parts)

    cmd = ['ffmpeg', '-y'] + inputs + [
        '-filter_complex', filter_complex,
        '-map', '[vout]', '-map', '[aout]',
        '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac',
        output_path
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    logger.info(f"Crossfade composited {n} turns -> {output_path}")


def composite_multitalk(segments, output_path, resolution="1280x720", crossfade_duration=0.3):
    """Composite MultiTalk segments — each segment already contains both people.

    Simply concatenates turn videos with optional crossfade, rescaling to target resolution.
    """
    res_parts = resolution.split("x")
    out_h, out_w = int(res_parts[0]), int(res_parts[1])
    temp_dir = os.path.dirname(segments[0][1])
    turn_videos = []

    for i, (_, video_path, _) in enumerate(segments):
        scaled_output = os.path.join(temp_dir, f"mt_scaled_{i}.mp4")
        cmd = ['ffmpeg', '-y', '-i', video_path,
               '-vf', f'scale={out_w}:{out_h}:force_original_aspect_ratio=increase,'
                      f'crop={out_w}:{out_h}',
               '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', scaled_output]
        subprocess.run(cmd, check=True, capture_output=True)
        turn_videos.append(scaled_output)

    if len(turn_videos) <= 1:
        if turn_videos:
            subprocess.run(['cp', turn_videos[0], output_path], check=True)
        return
    _concat_with_crossfade(turn_videos, output_path, temp_dir, crossfade_duration)


def composite_alpha(
    segments: list,
    agents: dict,
    output_path: str,
    resolution: str = "1280x720",
    idle_videos: dict = None,
    bg_image_path: str = None,
):
    """Alpha composite: shared background + per-agent person extraction.

    Each agent's video is matted (rembg) and composited onto a single background.
    Eliminates seam artifacts entirely since the background is one image.
    """
    from PIL import Image
    from modules.video_matting import extract_person_frames, composite_onto_background, release_session

    res_parts = resolution.split("x")
    out_h, out_w = int(res_parts[0]), int(res_parts[1])

    # Load background
    if bg_image_path and os.path.exists(bg_image_path):
        bg = Image.open(bg_image_path).convert("RGB").resize((out_w, out_h), Image.LANCZOS)
    else:
        bg = Image.new("RGB", (out_w, out_h), (40, 40, 60))

    agent_ids = list(agents.keys())
    temp_dir = os.path.dirname(segments[0][1])

    # Group segments by turn and build per-turn composited videos
    turn_videos = []
    fps = 25  # FlashTalk default

    for i, (agent_id, video_path, audio_path) in enumerate(segments):
        logger.info(f"Alpha composite turn {i+1}/{len(segments)}: matting {agent_id}...")

        # Determine speaker and listener
        speaker_idx = agent_ids.index(agent_id)
        listener_id = agent_ids[1 - speaker_idx] if len(agent_ids) == 2 else agent_ids[0]

        # Extract speaker person frames
        speaker_frames = extract_person_frames(video_path)

        # For listener: use idle video if available, else hold last known frame
        listener_frames = []
        if idle_videos and listener_id in idle_videos:
            listener_frames = extract_person_frames(idle_videos[listener_id])
        else:
            # Create a static frame from the listener's face image
            from rembg import remove
            from modules.video_matting import _get_session
            listener_img = Image.open(agents[listener_id].face_image).convert("RGB")
            listener_rgba = remove(listener_img, session=_get_session())
            listener_frames = [listener_rgba] * len(speaker_frames)

        # Arrange: agent 0 on left (25%), agent 1 on right (75%)
        if speaker_idx == 0:
            frames_list = [speaker_frames, listener_frames]
        else:
            frames_list = [listener_frames, speaker_frames]

        positions = [(0.28, 1.0), (0.72, 1.0)]
        scales = [0.80, 0.80]

        turn_output = os.path.join(temp_dir, f"alpha_turn_{i}.mp4")
        composite_onto_background(
            bg_image=bg,
            person_frames_list=frames_list,
            positions=positions,
            scales=scales,
            fps=fps,
            output_path=turn_output,
            audio_paths=[audio_path],
        )
        turn_videos.append(turn_output)
        logger.info(f"Alpha composite turn {i+1}/{len(segments)} done")

    release_session()

    # Concatenate turn videos with crossfade
    if len(turn_videos) <= 1:
        if turn_videos:
            subprocess.run(['cp', turn_videos[0], output_path], check=True)
    else:
        _concat_with_crossfade(turn_videos, output_path, temp_dir, crossfade_duration=0.3)

    logger.info(f"Alpha composite done: {output_path}")


def composite_conversation(
    segments: list,
    agents: dict,
    layout: str,
    output_path: str,
    resolution: str = "1280x720",
    idle_videos: dict = None,
    multitalk: bool = False,
    alpha_composite: bool = False,
    bg_image_path: str = None,
) -> str:
    """Main entry point for conversation composition."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    if alpha_composite and layout == "split":
        composite_alpha(segments, agents, output_path, resolution,
                        idle_videos=idle_videos, bg_image_path=bg_image_path)
    elif multitalk:
        composite_multitalk(segments, output_path, resolution)
    elif layout == "split":
        composite_split(segments, agents, output_path, resolution, idle_videos=idle_videos)
    elif layout == "pip":
        composite_pip(segments, agents, output_path, resolution, idle_videos=idle_videos)
    else:
        composite_switch(segments, agents, output_path, resolution)

    return output_path
