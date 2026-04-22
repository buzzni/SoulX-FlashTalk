"""Composite Generator — Phase 2 (pipeline-v2 Stage 2).

Generates N=4 composite candidate images via Gemini image generation.
Each candidate = host + products + background, composed into a single scene.

Features:
- N parallel Gemini calls with partial-success tolerance (min_success=2)
- Product image rembg preprocessing (toggle off via ?rembg=false)
- Korean direction → English scene-prompt translation (cached)
- Shot/angle/background-type enum validation
- Semaphore cap on concurrent Gemini calls to prevent singleton tear-down races

See specs/hoststudio-migration/plan.md §Phase 2.
"""
from __future__ import annotations

import asyncio
import functools
import logging
import os
import uuid
from io import BytesIO
from typing import AsyncIterator, Dict, List, Literal, Optional, Tuple

from PIL import Image

import config

logger = logging.getLogger(__name__)

Shot = Literal["closeup", "bust", "medium", "full"]
Angle = Literal["eye", "low", "high"]
BackgroundType = Literal["preset", "upload", "prompt"]

VALID_SHOTS = {"closeup", "bust", "medium", "full"}
VALID_ANGLES = {"eye", "low", "high"}
VALID_BG_TYPES = {"preset", "upload", "prompt"}

# Shared Gemini concurrency cap (prevents release_models() teardown race)
_gemini_semaphore = asyncio.Semaphore(8)

# Text-translation model (separate from image model)
GEMINI_TEXT_MODEL = "gemini-2.5-flash"


def _validate_enums(shot: str, angle: str, background_type: str) -> None:
    if shot not in VALID_SHOTS:
        raise ValueError(f"Invalid shot={shot!r}; must be one of {sorted(VALID_SHOTS)}")
    if angle not in VALID_ANGLES:
        raise ValueError(f"Invalid angle={angle!r}; must be one of {sorted(VALID_ANGLES)}")
    if background_type not in VALID_BG_TYPES:
        raise ValueError(
            f"Invalid backgroundType={background_type!r}; "
            f"must be one of {sorted(VALID_BG_TYPES)}"
        )


def _shot_clause(shot: str) -> str:
    return {
        "closeup": "extreme close-up framing, head and shoulders fill most of the frame",
        "bust": "bust shot, chest and up visible",
        "medium": "medium shot, from the waist up",
        "full": "full-body shot, head to feet visible",
    }[shot]


def _angle_clause(angle: str) -> str:
    return {
        "eye": "camera at natural eye level, straight-on",
        "low": "slight low angle looking up at the subject",
        "high": "slight high angle looking down toward the subject",
    }[angle]


@functools.lru_cache(maxsize=512)
def translate_direction_ko_to_en(direction_ko: str) -> str:
    """Translate Korean scene direction → English via Gemini Flash text model.

    Cached: the same direction fires across N=4 parallel calls in one request.
    Falls back to the original Korean text if Gemini is unavailable or fails,
    since Gemini image gen also accepts Korean reasonably well.
    """
    if not direction_ko or not direction_ko.strip():
        return ""

    try:
        from google.genai import types
        from modules.image_compositor import _get_gemini_client

        client = _get_gemini_client()
        # Translation is a short, deterministic task — skip the Flash model's
        # "thinking" pass (saves ~200-400ms per call) and cap output so a
        # runaway response can't blow up cost/latency. 256 tokens ≈ 350 Korean
        # chars worth of English, well above any reasonable direction line.
        cfg = types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(thinking_level="minimal"),
            max_output_tokens=256,
            system_instruction=(
                "You translate Korean scene directions into concise English for "
                "image generation. Return ONLY the translation — no quotes, no "
                "commentary, no leading label."
            ),
        )
        response = client.models.generate_content(
            model=GEMINI_TEXT_MODEL,
            contents=[f"Korean: {direction_ko}\n\nEnglish:"],
            config=cfg,
        )
        text = (response.text or "").strip().strip('"').strip("'")
        if not text:
            logger.warning("ko→en translation empty; using original Korean")
            return direction_ko
        return text
    except Exception as e:
        logger.warning("ko→en translation failed (%s); using original Korean", e)
        return direction_ko


def _build_scene_prompt(
    direction_en: str,
    shot: str,
    angle: str,
    background_type: str,
    background_prompt: Optional[str],
    background_preset_label: Optional[str],
) -> str:
    parts: List[str] = []

    if background_type == "prompt" and background_prompt:
        parts.append(background_prompt)
    elif background_type == "preset" and background_preset_label:
        parts.append(f"background: {background_preset_label}")
    elif background_type == "upload":
        parts.append("use the provided background reference image as the scene backdrop")

    if direction_en:
        parts.append(direction_en)

    parts.append(_shot_clause(shot))
    parts.append(_angle_clause(angle))
    parts.append(
        "Natural studio lighting. Products visible and prominent. "
        "Photorealistic. No text, captions, or watermarks."
    )
    return ". ".join(p.rstrip(".") for p in parts) + "."


def _preprocess_product(path: str, tmp_dir: str, apply_rembg: bool) -> str:
    """Optionally run rembg on a product image; return path to processed PNG."""
    if not apply_rembg:
        return path

    from modules.image_compositor import _remove_bg

    rgba = _remove_bg(path)
    os.makedirs(tmp_dir, exist_ok=True)
    out_path = os.path.join(tmp_dir, f"product_rembg_{uuid.uuid4().hex[:8]}.png")
    rgba.save(out_path, "PNG")
    logger.info("Product rembg preprocess: %s → %s", path, out_path)
    return out_path


async def generate_composite_candidates(
    host_image_path: str,
    product_image_paths: List[str],
    background_type: str,
    background_preset_id: Optional[str] = None,
    background_preset_label: Optional[str] = None,
    background_upload_path: Optional[str] = None,
    background_prompt: Optional[str] = None,
    direction_ko: str = "",
    shot: str = "bust",
    angle: str = "eye",
    n: int = 4,
    rembg_products: bool = True,
    timeout_per_call: float = 45.0,
    min_success: int = 2,
    output_dir: Optional[str] = None,
    target_size: Tuple[int, int] = (720, 1280),
    temperature: Optional[float] = None,
) -> Dict:
    """Generate N composite candidates. Returns partial success if ≥min_success.

    Returns:
        {
          "candidates": [{"seed": int, "path": str, "url": str}, ...],
          "partial": bool,
          "errors": [str, ...] | None,
          "direction_ko": str,
          "direction_en": str,
        }

    Raises:
        ValueError: invalid enum or missing required field
        RuntimeError: fewer than min_success candidates succeeded
    """
    _validate_enums(shot, angle, background_type)

    if not host_image_path:
        raise ValueError("host_image_path is required")
    if background_type == "upload" and not background_upload_path:
        raise ValueError("backgroundType='upload' requires backgroundUploadPath")
    if background_type == "preset" and not background_preset_id:
        raise ValueError("backgroundType='preset' requires backgroundPresetId")

    out_dir = output_dir or os.path.join(config.OUTPUTS_DIR, "composites")
    os.makedirs(out_dir, exist_ok=True)
    tmp_dir = os.path.join(out_dir, "_tmp")

    # Preprocess products (rembg toggle). Runs in executor since rembg is sync.
    loop = asyncio.get_running_loop()
    processed_products: List[str] = []
    if product_image_paths:
        processed_products = await loop.run_in_executor(
            None,
            lambda: [
                _preprocess_product(p, tmp_dir, apply_rembg=rembg_products)
                for p in product_image_paths
            ],
        )

    # Korean → English (cached; N=4 burst hits the cache after first call)
    direction_en = await loop.run_in_executor(
        None, translate_direction_ko_to_en, direction_ko
    )

    scene_prompt = _build_scene_prompt(
        direction_en=direction_en,
        shot=shot,
        angle=angle,
        background_type=background_type,
        background_prompt=background_prompt,
        background_preset_label=background_preset_label,
    )

    # Fixed seeds for filename reproducibility (Gemini sampling still differs per call)
    seeds = [10, 42, 77, 128, 256, 512, 1024, 2048][:n]

    tasks = [
        _generate_one(
            seed=s,
            host_image_path=host_image_path,
            product_image_paths=processed_products,
            background_upload_path=background_upload_path,
            scene_prompt=scene_prompt,
            target_size=target_size,
            output_dir=out_dir,
            timeout=timeout_per_call,
            temperature=temperature,
        )
        for s in seeds
    ]

    results = await asyncio.gather(*tasks, return_exceptions=True)

    candidates: List[Dict] = []
    errors: List[str] = []
    for seed, res in zip(seeds, results):
        if isinstance(res, Exception):
            logger.warning("Composite candidate seed=%s failed: %s", seed, res)
            errors.append(f"seed={seed}: {type(res).__name__}: {res}")
        elif res:
            candidates.append({
                "seed": seed,
                "path": res,
                # /api/files prepends a SAFE_ROOT (OUTPUTS_DIR here) — so the
                # path must be relative to OUTPUTS_DIR, not PROJECT_ROOT.
                "url": f"/api/files/{os.path.relpath(res, config.OUTPUTS_DIR)}",
            })

    if len(candidates) < min_success:
        raise RuntimeError(
            f"Only {len(candidates)}/{n} composite candidates succeeded "
            f"(need ≥{min_success}). Errors: {'; '.join(errors)}"
        )

    return {
        "candidates": candidates,
        "partial": len(candidates) < n,
        "errors": errors if errors else None,
        "direction_ko": direction_ko,
        "direction_en": direction_en,
    }


async def stream_composite_candidates(
    host_image_path: str,
    product_image_paths: List[str],
    background_type: str,
    background_preset_id: Optional[str] = None,
    background_preset_label: Optional[str] = None,
    background_upload_path: Optional[str] = None,
    background_prompt: Optional[str] = None,
    direction_ko: str = "",
    shot: str = "bust",
    angle: str = "eye",
    n: int = 4,
    rembg_products: bool = True,
    timeout_per_call: float = 45.0,
    min_success: int = 2,
    output_dir: Optional[str] = None,
    target_size: Tuple[int, int] = (720, 1280),
    temperature: Optional[float] = None,
) -> AsyncIterator[Dict]:
    """Async generator twin of generate_composite_candidates.

    Yields:
      {"type": "init",      "direction_ko", "direction_en"}
      {"type": "candidate", "seed", "path", "url", "done", "total"}
      {"type": "error",     "seed", "error", "done", "total"}
      {"type": "done",      "success_count", "total", "partial", "min_success_met",
                            "direction_ko", "direction_en"}
    """
    _validate_enums(shot, angle, background_type)

    if not host_image_path:
        raise ValueError("host_image_path is required")
    if background_type == "upload" and not background_upload_path:
        raise ValueError("backgroundType='upload' requires backgroundUploadPath")
    if background_type == "preset" and not background_preset_id:
        raise ValueError("backgroundType='preset' requires backgroundPresetId")

    out_dir = output_dir or os.path.join(config.OUTPUTS_DIR, "composites")
    os.makedirs(out_dir, exist_ok=True)
    tmp_dir = os.path.join(out_dir, "_tmp")

    loop = asyncio.get_running_loop()
    processed_products: List[str] = []
    if product_image_paths:
        processed_products = await loop.run_in_executor(
            None,
            lambda: [
                _preprocess_product(p, tmp_dir, apply_rembg=rembg_products)
                for p in product_image_paths
            ],
        )

    direction_en = await loop.run_in_executor(
        None, translate_direction_ko_to_en, direction_ko
    )
    yield {"type": "init", "direction_ko": direction_ko, "direction_en": direction_en}

    scene_prompt = _build_scene_prompt(
        direction_en=direction_en,
        shot=shot,
        angle=angle,
        background_type=background_type,
        background_prompt=background_prompt,
        background_preset_label=background_preset_label,
    )

    seeds = [10, 42, 77, 128, 256, 512, 1024, 2048][:n]

    async def _run_tagged(seed: int):
        try:
            path = await _generate_one(
                seed=seed,
                host_image_path=host_image_path,
                product_image_paths=processed_products,
                background_upload_path=background_upload_path,
                scene_prompt=scene_prompt,
                target_size=target_size,
                output_dir=out_dir,
                timeout=timeout_per_call,
                temperature=temperature,
            )
            return (seed, path, None, None)
        except Exception as e:
            cat = getattr(e, "category", "other")
            return (seed, None, f"{type(e).__name__}: {e}", cat)

    pending = [_run_tagged(s) for s in seeds]
    done_count = 0
    success_count = 0
    for coro in asyncio.as_completed(pending):
        seed, path, err, category = await coro
        done_count += 1
        if err:
            logger.warning("Composite candidate seed=%s failed (%s): %s", seed, category, err)
            yield {
                "type": "error",
                "seed": seed,
                "error": err,
                "category": category,
                "done": done_count,
                "total": n,
            }
        elif path:
            success_count += 1
            yield {
                "type": "candidate",
                "seed": seed,
                "path": path,
                "url": f"/api/files/{os.path.relpath(path, config.OUTPUTS_DIR)}",
                "done": done_count,
                "total": n,
            }

    yield {
        "type": "done",
        "success_count": success_count,
        "total": n,
        "partial": success_count < n,
        "min_success_met": success_count >= min_success,
        "direction_ko": direction_ko,
        "direction_en": direction_en,
    }


async def _generate_one(
    seed: int,
    host_image_path: str,
    product_image_paths: List[str],
    background_upload_path: Optional[str],
    scene_prompt: str,
    target_size: Tuple[int, int],
    output_dir: str,
    timeout: float,
    temperature: Optional[float] = None,
) -> Optional[str]:
    """Single Gemini call with per-call timeout + semaphore-bounded concurrency."""
    async with _gemini_semaphore:
        return await asyncio.wait_for(
            _run_gemini(
                seed=seed,
                host_image_path=host_image_path,
                product_image_paths=product_image_paths,
                background_upload_path=background_upload_path,
                scene_prompt=scene_prompt,
                target_size=target_size,
                output_dir=output_dir,
                temperature=temperature,
            ),
            timeout=timeout,
        )


async def _run_gemini(
    seed: int,
    host_image_path: str,
    product_image_paths: List[str],
    background_upload_path: Optional[str],
    scene_prompt: str,
    target_size: Tuple[int, int],
    output_dir: str,
    temperature: Optional[float] = None,
) -> Optional[str]:
    """Wrap the sync Gemini call in an executor."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None,
        lambda: _sync_generate(
            seed, host_image_path, product_image_paths,
            background_upload_path, scene_prompt, target_size, output_dir,
            temperature=temperature,
        ),
    )


def _sync_generate(
    seed: int,
    host_image_path: str,
    product_image_paths: List[str],
    background_upload_path: Optional[str],
    scene_prompt: str,
    target_size: Tuple[int, int],
    output_dir: str,
    temperature: Optional[float] = None,
) -> Optional[str]:
    """Run one Gemini image generation; return saved PNG path (or None)."""
    from modules.image_compositor import (
        GEMINI_IMAGE_MODEL,
        _build_people_canvas,
        _gemini_generate_scene,
        _remove_bg,
        write_generation_metadata,
    )

    # Extract host foreground
    host_rgba = _remove_bg(host_image_path)
    people_canvas = _build_people_canvas([host_rgba], target_size, scale=0.75)

    # Assemble reference images (products + optional background image)
    ref_images: List[Image.Image] = []
    for p in product_image_paths:
        if os.path.exists(p):
            ref_images.append(Image.open(p).convert("RGB"))
    if background_upload_path and os.path.exists(background_upload_path):
        ref_images.append(Image.open(background_upload_path).convert("RGB"))

    # _gemini_generate_scene now raises GeminiImageError on failure (was
    # returning None before). Propagate so the stream layer shows category.
    result = _gemini_generate_scene(
        people_canvas, scene_prompt, target_size, ref_images or None,
        seed=seed, temperature=temperature,
    )
    if result is None:
        return None

    out_path = os.path.join(output_dir, f"composite_s{seed}_{uuid.uuid4().hex[:8]}.png")
    result.save(out_path, "PNG")
    write_generation_metadata(out_path, {
        "step": "2-composite",
        "model": GEMINI_IMAGE_MODEL,
        "seed": seed,
        "temperature": temperature,
        "scene_prompt": scene_prompt,
        "host_image": host_image_path,
        "products": product_image_paths,
        "background_upload": background_upload_path,
        "target_size": list(target_size),
    })
    logger.info("Composite saved: %s", out_path)
    return out_path
