"""USP multi-GPU FlashTalk worker, invoked by the FastAPI backend via
`torchrun --nproc_per_node=2`. Rank 0 emits one JSON progress line per
significant transition; other ranks stay silent. The parent (app.py) parses
those lines and updates SSE progress.

Contract (stdout, rank 0 only, one JSON object per line):
  {"type":"progress","stage":"loading_model","pct":0.05}
  {"type":"progress","stage":"compiling","pct":0.15}
  {"type":"progress","stage":"generating","idx":3,"total":28,"pct":0.42}
  {"type":"progress","stage":"saving","pct":0.92}
  {"type":"done","output_path":"/abs/path/to.mp4","elapsed_s":612.3}
  {"type":"error","kind":"oom|other","msg":"..."}

Non-JSON lines on stdout/stderr (loguru, torch warnings) are ignored by
the parent but still drained and ring-buffered for diagnostics.
"""

import argparse
import json
import os
import sys
import time
import traceback
from collections import deque
from datetime import datetime

# torchrun puts only this script's directory on sys.path, so the
# repo-root flash_talk/ package isn't importable without help.
_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_HERE)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

import numpy as np
import torch
import torch.distributed as dist
import librosa
import imageio
import subprocess

from flash_talk.inference import (
    get_pipeline,
    get_audio_embedding,
    run_pipeline,
    infer_params,
)


def _is_rank0() -> bool:
    return int(os.environ.get("RANK", "0")) == 0


def emit(payload: dict) -> None:
    if not _is_rank0():
        return
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _trim_audio(wav: np.ndarray, sample_rate: int) -> np.ndarray:
    enabled = os.environ.get("AUDIO_TRIM_ENABLED", "1") == "1"
    if not enabled or len(wav) == 0:
        return wav
    top_db = float(os.environ.get("AUDIO_TRIM_TOP_DB", "40"))
    pad_ms = int(os.environ.get("AUDIO_TRIM_PAD_MS", "200"))
    trimmed, _ = librosa.effects.trim(wav, top_db=top_db)
    pad_samples = int(pad_ms * sample_rate / 1000)
    if pad_samples > 0:
        pad = np.zeros(pad_samples, dtype=trimmed.dtype)
        trimmed = np.concatenate([pad, trimmed, pad])
    if len(trimmed) < sample_rate * 0.5:
        return wav  # fall back to original; trim too aggressive
    return trimmed


def _save_video(frames_list, video_path: str, audio_path: str, fps: int) -> None:
    temp_video_path = video_path.replace(".mp4", "_temp.mp4")
    with imageio.get_writer(
        temp_video_path,
        format="mp4",
        mode="I",
        fps=fps,
        codec="h264",
        ffmpeg_params=["-bf", "0"],
    ) as writer:
        for frames in frames_list:
            arr = frames.numpy().astype(np.uint8)
            for i in range(arr.shape[0]):
                writer.append_data(arr[i])
    cmd = [
        "ffmpeg", "-y",
        "-i", temp_video_path,
        "-i", audio_path,
        "-c:v", "copy", "-c:a", "aac", "-shortest",
        video_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    if os.path.exists(temp_video_path):
        os.remove(temp_video_path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ckpt_dir", required=True)
    parser.add_argument("--wav2vec_dir", required=True)
    parser.add_argument("--input_prompt", required=True)
    parser.add_argument("--cond_image", required=True)
    parser.add_argument("--audio_path", required=True)
    parser.add_argument("--save_path", required=True, help="Final output mp4 absolute path")
    parser.add_argument("--target_h", type=int, required=True)
    parser.add_argument("--target_w", type=int, required=True)
    parser.add_argument("--base_seed", type=int, default=9999)
    parser.add_argument("--audio_encode_mode", choices=["stream", "once"], default="stream")
    args = parser.parse_args()

    start_ts = time.time()
    world_size = int(os.environ.get("WORLD_SIZE", "1"))

    try:
        # parent already emitted starting_subprocess at 0.05 — start the
        # child timeline above that so the bar never goes backward.
        emit({"type": "progress", "stage": "loading_model", "pct": 0.10})

        # cpu_offload=False under USP (handled inside FlashTalkPipeline:78);
        # pass False explicitly so torch.compile path activates too.
        pipeline = get_pipeline(
            world_size=world_size,
            ckpt_dir=args.ckpt_dir,
            wav2vec_dir=args.wav2vec_dir,
            cpu_offload=False,
        )

        emit({"type": "progress", "stage": "compiling", "pct": 0.20})

        pipeline.prepare_params(
            input_prompt=args.input_prompt,
            cond_image=args.cond_image,
            target_size=(args.target_h, args.target_w),
            frame_num=infer_params["frame_num"],
            motion_frames_num=infer_params["motion_frames_num"],
            sampling_steps=infer_params["sample_steps"],
            seed=args.base_seed,
            shift=infer_params["sample_shift"],
            color_correction_strength=infer_params["color_correction_strength"],
        )

        sample_rate = infer_params["sample_rate"]
        tgt_fps = infer_params["tgt_fps"]
        cached_audio_duration = infer_params["cached_audio_duration"]
        frame_num = infer_params["frame_num"]
        motion_frames_num = infer_params["motion_frames_num"]
        slice_len = frame_num - motion_frames_num

        wav, _ = librosa.load(args.audio_path, sr=sample_rate, mono=True)
        wav = _trim_audio(wav, sample_rate)

        slice_samples = slice_len * sample_rate // tgt_fps
        frame_samples = frame_num * sample_rate // tgt_fps

        generated_list = []

        if args.audio_encode_mode == "once":
            remainder = (len(wav) - frame_samples) % slice_samples
            if remainder > 0:
                wav = np.concatenate([wav, np.zeros(slice_samples - remainder, dtype=wav.dtype)])
            audio_emb_all = get_audio_embedding(pipeline, wav)
            chunks = [
                audio_emb_all[:, i * slice_len:i * slice_len + frame_num].contiguous()
                for i in range((audio_emb_all.shape[1] - frame_num) // slice_len)
            ]
            total = len(chunks)
            for idx, chunk in enumerate(chunks):
                torch.cuda.synchronize()
                video = run_pipeline(pipeline, chunk)
                if idx != 0:
                    video = video[motion_frames_num:]
                generated_list.append(video.cpu())
                emit({
                    "type": "progress", "stage": "generating",
                    "idx": idx + 1, "total": total,
                    "pct": 0.25 + 0.65 * (idx + 1) / total,
                })
        else:  # stream
            cached_samples = sample_rate * cached_audio_duration
            audio_end_idx = cached_audio_duration * tgt_fps
            audio_start_idx = audio_end_idx - frame_num
            audio_dq = deque([0.0] * cached_samples, maxlen=cached_samples)

            remainder = len(wav) % slice_samples
            if remainder > 0:
                wav = np.concatenate([wav, np.zeros(slice_samples - remainder, dtype=wav.dtype)])
            slices = wav.reshape(-1, slice_samples)
            total = len(slices)

            for idx, slc in enumerate(slices):
                audio_dq.extend(slc.tolist())
                audio_arr = np.array(audio_dq)
                audio_emb = get_audio_embedding(pipeline, audio_arr, audio_start_idx, audio_end_idx)
                torch.cuda.synchronize()
                video = run_pipeline(pipeline, audio_emb)
                video = video[motion_frames_num:]
                generated_list.append(video.cpu())
                emit({
                    "type": "progress", "stage": "generating",
                    "idx": idx + 1, "total": total,
                    "pct": 0.25 + 0.65 * (idx + 1) / total,
                })

        if _is_rank0():
            emit({"type": "progress", "stage": "saving", "pct": 0.92})
            _save_video(generated_list, args.save_path, args.audio_path, fps=tgt_fps)

        if world_size > 1:
            dist.barrier()
            dist.destroy_process_group()

        elapsed = time.time() - start_ts
        emit({"type": "done", "output_path": args.save_path, "elapsed_s": round(elapsed, 1)})
        return 0

    except torch.cuda.OutOfMemoryError as e:
        emit({"type": "error", "kind": "oom", "msg": str(e)[:500]})
        return 2
    except Exception as e:
        tb = traceback.format_exc()
        msg = (str(e) + "\n" + tb)[:1500]
        kind = "oom" if "out of memory" in msg.lower() else "other"
        emit({"type": "error", "kind": kind, "msg": msg})
        return 1


if __name__ == "__main__":
    sys.exit(main())
