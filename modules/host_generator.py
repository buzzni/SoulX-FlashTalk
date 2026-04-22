"""Host Maker — Phase 1 (pipeline-v2 Stage 1).

Generates AI show-host candidate images via Gemini image generation.
N=4 parallel calls with partial-success tolerance (min_success=2).

See specs/hoststudio-migration/plan.md §Phase 1.
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from typing import AsyncIterator, Dict, List, Literal, Optional

from PIL import Image

import config

logger = logging.getLogger(__name__)

Mode = Literal["text", "face-outfit", "style-ref"]

# Concurrent Gemini call cap (Phase 0 R9: prevents singleton tear-down races)
_gemini_semaphore = asyncio.Semaphore(8)


async def generate_host_candidates(
    mode: Mode,
    text_prompt: Optional[str] = None,
    face_ref_path: Optional[str] = None,
    outfit_ref_path: Optional[str] = None,
    style_ref_path: Optional[str] = None,
    extra_prompt: Optional[str] = None,
    builder: Optional[Dict[str, str]] = None,
    negative_prompt: Optional[str] = None,
    face_strength: float = 0.7,
    outfit_strength: float = 0.7,
    n: int = 4,
    timeout_per_call: float = 45.0,
    min_success: int = 2,
    output_dir: Optional[str] = None,
    temperature: Optional[float] = None,
) -> Dict:
    """Generate N=4 parallel host candidates. Returns partial success if ≥min_success.

    Args:
        mode: generation method (text / face-outfit / style-ref)
        text_prompt: user Korean prompt (required for 'text' mode)
        face_ref_path: face reference image path (for 'face-outfit')
        outfit_ref_path: outfit reference image path (for 'face-outfit')
        style_ref_path: single reference image (for 'style-ref')
        extra_prompt: additional user-provided wording
        builder: {성별, 연령대, 분위기, 옷차림} preset dict → suffixed to prompt
        negative_prompt: user avoid-list (§5.1.1 — concat into system_instruction)
        face_strength / outfit_strength: 0-1 thresholds (§5.1.2)
        n: number of candidates (default 4)
        timeout_per_call: per-Gemini call timeout (seconds)
        min_success: minimum successes before returning (raises RuntimeError otherwise)
        output_dir: directory for generated PNGs (defaults to HOSTS_DIR)

    Returns:
        {
          "candidates": [{"seed": int, "path": str, "url": str}, ...],
          "partial": bool,
          "errors": [str, ...],  # present if partial
        }

    Raises:
        ValueError: invalid mode / missing required inputs
        RuntimeError: fewer than min_success candidates succeeded
    """
    _validate_inputs(mode, text_prompt, face_ref_path, outfit_ref_path, style_ref_path)

    out_dir = output_dir or config.HOSTS_DIR
    os.makedirs(out_dir, exist_ok=True)

    # Fixed seeds for reproducibility parity with prototype (10, 42, 77, 128...)
    seeds = [10, 42, 77, 128, 256, 512, 1024, 2048][:n]

    tasks = [
        _generate_one(
            seed=s,
            mode=mode,
            text_prompt=text_prompt,
            face_ref_path=face_ref_path,
            outfit_ref_path=outfit_ref_path,
            style_ref_path=style_ref_path,
            extra_prompt=extra_prompt,
            builder=builder,
            negative_prompt=negative_prompt,
            face_strength=face_strength,
            outfit_strength=outfit_strength,
            timeout=timeout_per_call,
            output_dir=out_dir,
            temperature=temperature,
        )
        for s in seeds
    ]

    # asyncio.gather with return_exceptions=True: siblings NOT cancelled on raise
    results = await asyncio.gather(*tasks, return_exceptions=True)

    candidates: List[Dict] = []
    errors: List[str] = []
    for seed, res in zip(seeds, results):
        if isinstance(res, Exception):
            logger.warning("Host candidate seed=%s failed: %s", seed, res)
            errors.append(f"seed={seed}: {type(res).__name__}: {res}")
        elif res:
            candidates.append({
                "seed": seed,
                "path": res,
                # /api/files prepends a SAFE_ROOT (OUTPUTS_DIR here) — so the
                # path must be relative to OUTPUTS_DIR, not PROJECT_ROOT, or
                # we end up with "outputs/outputs/hosts/..." and a 404.
                "url": f"/api/files/{os.path.relpath(res, config.OUTPUTS_DIR)}",
            })

    if len(candidates) < min_success:
        raise RuntimeError(
            f"Only {len(candidates)}/{n} host candidates succeeded "
            f"(need ≥{min_success}). Errors: {'; '.join(errors)}"
        )

    return {
        "candidates": candidates,
        "partial": len(candidates) < n,
        "errors": errors if errors else None,
    }


async def stream_host_candidates(
    mode: Mode,
    text_prompt: Optional[str] = None,
    face_ref_path: Optional[str] = None,
    outfit_ref_path: Optional[str] = None,
    style_ref_path: Optional[str] = None,
    extra_prompt: Optional[str] = None,
    builder: Optional[Dict[str, str]] = None,
    negative_prompt: Optional[str] = None,
    face_strength: float = 0.7,
    outfit_strength: float = 0.7,
    n: int = 4,
    timeout_per_call: float = 45.0,
    min_success: int = 2,
    output_dir: Optional[str] = None,
    temperature: Optional[float] = None,
) -> AsyncIterator[Dict]:
    """Async generator — yields one event per candidate as it completes.

    Events:
      {"type": "candidate", "seed", "path", "url", "done", "total"}
      {"type": "error",     "seed", "error"}
      {"type": "done",      "success_count", "total", "partial"}

    The UI consumes these via SSE so each finished tile renders immediately
    instead of waiting for the slowest sibling (blocking gather).
    """
    _validate_inputs(mode, text_prompt, face_ref_path, outfit_ref_path, style_ref_path)

    out_dir = output_dir or config.HOSTS_DIR
    os.makedirs(out_dir, exist_ok=True)
    seeds = [10, 42, 77, 128, 256, 512, 1024, 2048][:n]

    async def _run_tagged(seed: int):
        try:
            path = await _generate_one(
                seed=seed,
                mode=mode,
                text_prompt=text_prompt,
                face_ref_path=face_ref_path,
                outfit_ref_path=outfit_ref_path,
                style_ref_path=style_ref_path,
                extra_prompt=extra_prompt,
                builder=builder,
                negative_prompt=negative_prompt,
                face_strength=face_strength,
                outfit_strength=outfit_strength,
                timeout=timeout_per_call,
                output_dir=out_dir,
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
            logger.warning("Host candidate seed=%s failed (%s): %s", seed, category, err)
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
    }


def _validate_inputs(mode, text_prompt, face_ref, outfit_ref, style_ref):
    if mode == "text":
        if not text_prompt or len(text_prompt.strip()) < 5:
            raise ValueError("'text' mode requires text_prompt (≥5 chars)")
    elif mode == "face-outfit":
        if not face_ref or not outfit_ref:
            raise ValueError("'face-outfit' mode requires both face_ref_path and outfit_ref_path")
    elif mode == "style-ref":
        if not style_ref:
            raise ValueError("'style-ref' mode requires style_ref_path")
    else:
        raise ValueError(f"Unknown mode: {mode}")


async def _generate_one(
    seed: int,
    mode: Mode,
    text_prompt: Optional[str],
    face_ref_path: Optional[str],
    outfit_ref_path: Optional[str],
    style_ref_path: Optional[str],
    extra_prompt: Optional[str],
    builder: Optional[Dict[str, str]],
    negative_prompt: Optional[str],
    face_strength: float,
    outfit_strength: float,
    timeout: float,
    output_dir: str,
    temperature: Optional[float] = None,
) -> Optional[str]:
    """Single Gemini call with per-call timeout + semaphore-bounded concurrency."""
    async with _gemini_semaphore:
        return await asyncio.wait_for(
            _run_gemini(
                seed=seed,
                mode=mode,
                text_prompt=text_prompt,
                face_ref_path=face_ref_path,
                outfit_ref_path=outfit_ref_path,
                style_ref_path=style_ref_path,
                extra_prompt=extra_prompt,
                builder=builder,
                negative_prompt=negative_prompt,
                face_strength=face_strength,
                outfit_strength=outfit_strength,
                output_dir=output_dir,
                temperature=temperature,
            ),
            timeout=timeout,
        )


async def _run_gemini(
    seed: int,
    mode: Mode,
    text_prompt: Optional[str],
    face_ref_path: Optional[str],
    outfit_ref_path: Optional[str],
    style_ref_path: Optional[str],
    extra_prompt: Optional[str],
    builder: Optional[Dict[str, str]],
    negative_prompt: Optional[str],
    face_strength: float,
    outfit_strength: float,
    output_dir: str,
    temperature: Optional[float] = None,
) -> Optional[str]:
    """Wrap the (sync) Gemini client call in an executor."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None,
        lambda: _sync_generate(
            seed, mode, text_prompt, face_ref_path, outfit_ref_path,
            style_ref_path, extra_prompt, builder, negative_prompt,
            face_strength, outfit_strength, output_dir,
            temperature=temperature,
        ),
    )


def _sync_generate(
    seed, mode, text_prompt, face_ref_path, outfit_ref_path,
    style_ref_path, extra_prompt, builder, negative_prompt,
    face_strength, outfit_strength, output_dir,
    temperature: Optional[float] = None,
) -> Optional[str]:
    from io import BytesIO

    from modules.image_compositor import (
        GEMINI_IMAGE_MODEL,
        _build_gemini_image_config,
        _call_gemini_with_retry,
        _classify_sdk_exception,
        _diagnose_empty_response,
        _get_gemini_client,
        _sanitize_user_prompt,
        GeminiImageError,
        write_generation_metadata,
    )

    # Portrait 9:16 for show-host (matches HostStudio design)
    target_size = (448, 768)

    prompt = _build_host_prompt(
        mode=mode,
        text_prompt=text_prompt,
        extra_prompt=extra_prompt,
        builder=builder,
        face_strength=face_strength,
        outfit_strength=outfit_strength,
    )
    prompt = _sanitize_user_prompt(prompt)

    sys_instruction = _build_host_system_instruction(negative_prompt)

    client = _get_gemini_client()
    contents = [prompt]
    has_ref = False
    for ref in (face_ref_path, outfit_ref_path, style_ref_path):
        if ref and os.path.exists(ref):
            contents.append(Image.open(ref).convert("RGB"))
            has_ref = True

    # face-outfit / style-ref modes rely on reference detail — HIGH media res
    # preserves more of that input. Pure text mode gets MEDIUM (default-ish)
    # since there's no ref image to study.
    media_res = "MEDIA_RESOLUTION_HIGH" if has_ref else "MEDIA_RESOLUTION_MEDIUM"

    def _do():
        return client.models.generate_content(
            model=GEMINI_IMAGE_MODEL,
            contents=contents,
            config=_build_gemini_image_config(
                target_size,
                sys_instruction,
                person_generation="ALLOW_ADULT",
                seed=seed,
                media_resolution=media_res,
                temperature=temperature,
            ),
        )
    try:
        response = _call_gemini_with_retry(_do)
    except GeminiImageError:
        raise
    except Exception as e:
        raise _classify_sdk_exception(e)

    candidates = getattr(response, "candidates", None) or []
    if candidates:
        for part in candidates[0].content.parts:
            if part.inline_data is not None:
                result = Image.open(BytesIO(part.inline_data.data)).convert("RGB")
                out_path = os.path.join(output_dir, f"host_{uuid.uuid4().hex[:8]}_s{seed}.png")
                result.save(out_path, "PNG")
                write_generation_metadata(out_path, {
                    "step": "1-host",
                    "model": GEMINI_IMAGE_MODEL,
                    "seed": seed,
                    "temperature": temperature,
                    "media_resolution": media_res,
                    "mode": mode,
                    "prompt": prompt,
                    "system_instruction": sys_instruction,
                    "has_face_ref": bool(face_ref_path),
                    "has_outfit_ref": bool(outfit_ref_path),
                    "has_style_ref": bool(style_ref_path),
                    "face_strength": face_strength,
                    "outfit_strength": outfit_strength,
                })
                return out_path

    logger.warning("Gemini returned no image for host seed=%s", seed)
    raise _diagnose_empty_response(response)


def _build_host_prompt(
    mode: Mode,
    text_prompt: Optional[str],
    extra_prompt: Optional[str],
    builder: Optional[Dict[str, str]],
    face_strength: float,
    outfit_strength: float,
) -> str:
    """Assemble Korean + English scaffolding into a single Gemini prompt."""
    parts = ["AI 쇼호스트 인물 사진, 9:16 세로 프레임, 스튜디오 조명, 사실적 인물사진."]
    if text_prompt:
        parts.append(text_prompt)
    if builder:
        suffix = [f"{k}: {v}" for k, v in builder.items() if v]
        if suffix:
            parts.append("특성: " + ", ".join(suffix))
    if extra_prompt:
        parts.append(extra_prompt)
    if mode == "face-outfit":
        parts.append(_strength_phrase("face", face_strength))
        parts.append(_strength_phrase("outfit", outfit_strength))
    elif mode == "style-ref":
        parts.append(_strength_phrase("face", face_strength))
    return "\n\n".join(parts)


def _strength_phrase(kind: str, s: float) -> str:
    """§5.1.2 threshold: numeric strength → English instruction phrase."""
    if s < 0.3:
        return f"Take only loose inspiration from the reference {kind}; prioritize the text description."
    if s < 0.6:
        return f"Use the reference {kind} as a general style guide."
    if s < 0.85:
        return f"Preserve the key features of the reference {kind} closely."
    return f"Match the reference {kind} as exactly as possible."


def _build_host_system_instruction(negative_prompt: Optional[str]) -> str:
    """§5.1.1: system_instruction for host generation."""
    base = (
        "Generate a single person (AI shopping host) in a neutral pose. "
        "No products, no furniture, no complex background. "
        "Focus on face and outfit clarity. "
        "Photorealistic portrait. No text, no watermarks, no logos."
    )
    if negative_prompt:
        base += f"\n\nAvoid the following in the output: {negative_prompt}"
    return base
