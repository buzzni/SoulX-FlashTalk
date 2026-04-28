"""MuseTalk hybrid post-process for Korean lip-sync.

Runs after SoulX-FlashTalk has produced a video. The SoulX output uses a
chinese-wav2vec2 audio encoder, which mishandles Korean phonemes — visible
as awkward ㅁ/ㅂ/ㅍ closures, lateral mouth stretching, and ㄹ받침 misalign.

MuseTalk 1.5 uses Whisper-tiny (multilingual) as its audio encoder and
inpaints the lip + jaw region. With `upper_boundary_ratio=0.4` (custom; the
default 0.5 leaves jaw under SoulX control) the lower face follows the
Whisper interpretation of the Korean audio.

The post-process is a separate Python 3.10 / PyTorch 2.0.1 venv at
`/opt/home/jack/workspace/musetalk-poc/`. We invoke it via subprocess so
the main backend can stay on Python 3.11 / PyTorch 2.7.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import time

import yaml

logger = logging.getLogger(__name__)

MUSETALK_ROOT = "/opt/home/jack/workspace/musetalk-poc/MuseTalk"
MUSETALK_PYTHON = "/opt/home/jack/workspace/musetalk-poc/.venv/bin/python"
MUSETALK_GPU = os.environ.get("MUSETALK_GPU", "1")


def _basename_no_ext(path: str) -> str:
    return os.path.splitext(os.path.basename(path))[0]


def apply_hybrid(soulx_mp4: str, audio_path: str, *, timeout_s: int = 600) -> bool:
    """Replace soulx_mp4 with the MuseTalk hybrid version.

    On success, the original SoulX file is preserved at ``<base>_raw.mp4`` and
    soulx_mp4 now contains the lip-sync-corrected hybrid. On any failure
    (subprocess error, timeout, missing output) the function logs and returns
    False, leaving soulx_mp4 untouched — the caller falls back to the SoulX
    raw output.
    """
    if not os.path.isdir(MUSETALK_ROOT) or not os.path.isfile(MUSETALK_PYTHON):
        logger.warning(f"MuseTalk install missing at {MUSETALK_ROOT}; skipping hybrid")
        return False
    if not os.path.isfile(soulx_mp4):
        logger.warning(f"MuseTalk hybrid: soulx_mp4 missing: {soulx_mp4}")
        return False
    if not os.path.isfile(audio_path):
        logger.warning(f"MuseTalk hybrid: audio_path missing: {audio_path}")
        return False

    cfg_dir = os.path.join(MUSETALK_ROOT, "configs", "inference")
    os.makedirs(cfg_dir, exist_ok=True)
    cfg_handle = tempfile.NamedTemporaryFile(
        prefix="auto_",
        suffix=".yaml",
        dir=cfg_dir,
        delete=False,
        mode="w",
    )
    cfg_path = cfg_handle.name
    yaml.safe_dump(
        {"task_0": {"video_path": soulx_mp4, "audio_path": audio_path}},
        cfg_handle,
    )
    cfg_handle.close()

    run_id = f"auto_{os.getpid()}_{int(time.time())}"
    result_dir = os.path.join(MUSETALK_ROOT, "results", run_id)
    os.makedirs(result_dir, exist_ok=True)

    cmd = [
        MUSETALK_PYTHON,
        "-m",
        "scripts.inference",
        "--inference_config",
        cfg_path,
        "--result_dir",
        result_dir,
        "--unet_model_path",
        "models/musetalkV15/unet.pth",
        "--unet_config",
        "models/musetalkV15/musetalk.json",
        "--version",
        "v15",
    ]
    env = {**os.environ, "CUDA_VISIBLE_DEVICES": MUSETALK_GPU}

    soulx_base = _basename_no_ext(soulx_mp4)
    audio_base = _basename_no_ext(audio_path)
    expected_out = os.path.join(result_dir, "v15", f"{soulx_base}_{audio_base}.mp4")

    try:
        proc = subprocess.run(
            cmd,
            cwd=MUSETALK_ROOT,
            env=env,
            capture_output=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired:
        logger.warning(f"MuseTalk hybrid: timeout after {timeout_s}s")
        _cleanup(cfg_path, result_dir)
        return False
    except Exception as e:
        logger.warning(f"MuseTalk hybrid: subprocess error: {e}")
        _cleanup(cfg_path, result_dir)
        return False

    if proc.returncode != 0:
        logger.warning(
            f"MuseTalk hybrid: rc={proc.returncode}, stderr tail: "
            f"{proc.stderr.decode('utf-8', 'replace')[-400:]}"
        )
        _cleanup(cfg_path, result_dir)
        return False

    if not os.path.isfile(expected_out):
        logger.warning(f"MuseTalk hybrid: expected output missing: {expected_out}")
        _cleanup(cfg_path, result_dir)
        return False

    raw_backup = soulx_mp4.replace(".mp4", "_raw.mp4")
    try:
        shutil.move(soulx_mp4, raw_backup)
        shutil.move(expected_out, soulx_mp4)
    except OSError as e:
        logger.warning(f"MuseTalk hybrid: swap failed: {e}")
        # Try to restore raw if move chain broke partway through.
        if not os.path.isfile(soulx_mp4) and os.path.isfile(raw_backup):
            shutil.move(raw_backup, soulx_mp4)
        _cleanup(cfg_path, result_dir)
        return False

    _cleanup(cfg_path, result_dir)
    logger.info(f"MuseTalk hybrid: applied → {soulx_mp4} (raw preserved at {raw_backup})")
    return True


def _cleanup(cfg_path: str, result_dir: str) -> None:
    try:
        if os.path.isfile(cfg_path):
            os.remove(cfg_path)
    except OSError:
        pass
    try:
        shutil.rmtree(result_dir, ignore_errors=True)
    except OSError:
        pass
