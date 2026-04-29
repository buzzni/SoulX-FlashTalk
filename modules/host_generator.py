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

# Seed policy
# -----------
# FIXED_DEFAULT_SEEDS gives a deterministic first-time experience: two users
# with identical prompts see the same 4 candidates. This trades "every run
# feels fresh" for "shareability + A/B comparability" on first click.
#
# On "다시 만들기" the frontend bypasses these defaults by sending its own
# random seeds — users expect retry to produce NEW variants, not the same
# 4 again. _resolve_seeds handles the override.
FIXED_DEFAULT_SEEDS = [10, 42, 77, 128, 256, 512, 1024, 2048]


def _resolve_seeds(provided: Optional[List[int]], n: int) -> List[int]:
    """Caller seeds win; otherwise fall back to FIXED_DEFAULT_SEEDS."""
    if provided:
        coerced = [int(s) for s in provided[:n]]
        if len(coerced) < n:
            coerced += FIXED_DEFAULT_SEEDS[len(coerced):n]
        return coerced
    return FIXED_DEFAULT_SEEDS[:n]


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
    # Free-text outfit description — used INSTEAD of (or in addition to) the
    # outfit reference image. Lets users say "베이지 니트, 청바지" without
    # having to find an outfit photo.
    outfit_text: Optional[str] = None,
    # Optional explicit seeds — caller passes these on "다시 만들기" to force
    # fresh outputs instead of the deterministic default set. None falls back
    # to FIXED_DEFAULT_SEEDS (reproducible first-time experience).
    seeds: Optional[List[int]] = None,
    # Gemini image_size: "1K" (default, fast) or "2K" (sharper, ~2-4× cost).
    # Shared with Step 2 so the host reference resolution matches what Step 2
    # composes against — mismatched sizes risk hallucinated face detail.
    image_size: str = "1K",
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
    face_ref_path, outfit_ref_path, style_ref_path = _sanitize_refs_by_mode(
        mode, face_ref_path, outfit_ref_path, style_ref_path
    )
    _validate_inputs(mode, text_prompt, face_ref_path, outfit_ref_path, style_ref_path, outfit_text)

    out_dir = output_dir or config.HOSTS_DIR
    os.makedirs(out_dir, exist_ok=True)

    # Seed policy: first generate uses FIXED_DEFAULT_SEEDS for reproducibility
    # (so two users with the same prompt see the same 4 candidates on first
    # try). On "다시 만들기" the frontend passes fresh random seeds so the
    # user actually gets different output — see seed_policy note in
    # modules/host_generator.py at FIXED_DEFAULT_SEEDS.
    seeds = _resolve_seeds(seeds, n)
    from modules.image_compositor import scaled_timeout
    per_call_timeout = scaled_timeout(timeout_per_call, image_size)

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
            outfit_text=outfit_text,
            timeout=per_call_timeout,
            output_dir=out_dir,
            temperature=temperature,
            image_size=image_size,
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
            # url field gets populated by app.py:_upload_local_to_storage
            # after this returns — generators no longer construct URLs.
            candidates.append({"seed": seed, "path": res})

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
    outfit_text: Optional[str] = None,
    seeds: Optional[List[int]] = None,
    image_size: str = "1K",
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
    face_ref_path, outfit_ref_path, style_ref_path = _sanitize_refs_by_mode(
        mode, face_ref_path, outfit_ref_path, style_ref_path
    )
    _validate_inputs(mode, text_prompt, face_ref_path, outfit_ref_path, style_ref_path, outfit_text)

    out_dir = output_dir or config.HOSTS_DIR
    os.makedirs(out_dir, exist_ok=True)
    seeds = _resolve_seeds(seeds, n)
    from modules.image_compositor import scaled_timeout
    per_call_timeout = scaled_timeout(timeout_per_call, image_size)

    # Emit an init event up front so the UI can show its placeholder spinners
    # ONLY after the request has been accepted — previously Step1 drew the
    # 4 spinners as soon as the button was clicked, even when validation
    # failed and the user only saw an error toast. With init, the frontend
    # waits for this first byte to confirm the call succeeded.
    yield {"type": "init", "seeds": seeds, "total": n}

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
                outfit_text=outfit_text,
                timeout=per_call_timeout,
                output_dir=out_dir,
                temperature=temperature,
                image_size=image_size,
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
            # url field gets populated by app.py:_upload_local_to_storage
            # after this yields — stream consumers must wait for the swap.
            yield {
                "type": "candidate",
                "seed": seed,
                "path": path,
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


def _sanitize_refs_by_mode(
    mode: str,
    face_ref_path: Optional[str],
    outfit_ref_path: Optional[str],
    style_ref_path: Optional[str],
) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Defense-in-depth: drop ref paths that don't apply to the chosen mode.

    The frontend's mode switcher (Step1Host.tsx) only updates `host.mode` and
    leaves the previously-uploaded face/outfit refs in wizard state. A spread
    in handleGenerate then ships those stale paths back to /api/host/generate
    even after the user switched to "설명으로 만들기". Without this guard,
    `_sync_generate` (line ~425) silently attaches the leaked images to the
    Gemini contents list, producing variants that look like the prior session
    instead of the new text prompt.
    """
    if mode == "text":
        return None, None, None
    return face_ref_path, outfit_ref_path, style_ref_path


def _validate_inputs(mode, text_prompt, face_ref, outfit_ref, style_ref, outfit_text=None):
    """Require at least one usable input — text prompt, any reference image,
    or an outfit_text description. Mode strings are now purely informational
    (they drive logging / metadata); previously 'style-ref' hard-required
    style_ref_path which made "face-only + outfit text" break with an
    irrelevant error.
    """
    if mode not in {"text", "face-outfit", "style-ref"}:
        raise ValueError(f"Unknown mode: {mode}")
    if mode == "text":
        if not text_prompt or len(text_prompt.strip()) < 5:
            raise ValueError("'text' mode requires text_prompt (≥5 chars)")
        return
    # Image modes — accept any combination of face/outfit/style image plus
    # optional outfit_text. The generator skips missing inputs gracefully.
    has_any_input = bool(face_ref or outfit_ref or style_ref or (outfit_text and outfit_text.strip()))
    if not has_any_input:
        raise ValueError(
            f"'{mode}' mode needs at least one reference image or an outfit_text"
        )


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
    outfit_text: Optional[str] = None,
    image_size: str = "1K",
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
                outfit_text=outfit_text,
                output_dir=output_dir,
                temperature=temperature,
                image_size=image_size,
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
    outfit_text: Optional[str] = None,
    image_size: str = "1K",
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
            outfit_text=outfit_text,
            image_size=image_size,
        ),
    )


def _sync_generate(
    seed, mode, text_prompt, face_ref_path, outfit_ref_path,
    style_ref_path, extra_prompt, builder, negative_prompt,
    face_strength, outfit_strength, output_dir,
    temperature: Optional[float] = None,
    outfit_text: Optional[str] = None,
    image_size: str = "1K",
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

    # Strength clauses now go INLINE next to each labeled image (built below)
    # — leaving them in the prompt body without per-image anchoring let Gemini
    # ignore the outfit reference entirely (multiple unlabeled images all
    # treated as face refs). _build_host_prompt no longer emits them.
    prompt = _build_host_prompt(
        mode=mode,
        text_prompt=text_prompt,
        extra_prompt=extra_prompt,
        builder=builder,
        outfit_text=outfit_text,
    )
    prompt = _sanitize_user_prompt(prompt)

    sys_instruction = _build_host_system_instruction(negative_prompt)

    client = _get_gemini_client()

    # Interleave text labels + images so Gemini knows which attached image is
    # the face vs outfit vs style ref. Without this, all images blur into "a
    # bunch of references" and the model has no way to honor "use the OUTFIT
    # from image #2" — see bug report 2026-04-23 (face-outfit mode silently
    # ignored the outfit photo across all 4 candidates).
    contents = [prompt]
    has_ref = False
    if face_ref_path and os.path.exists(face_ref_path):
        contents.append(
            "[Reference image #1 — FACE]: This is the face/identity reference. "
            + _strength_phrase("face", face_strength)
        )
        contents.append(Image.open(face_ref_path).convert("RGB"))
        has_ref = True
    if outfit_ref_path and os.path.exists(outfit_ref_path):
        contents.append(
            "[Reference image — OUTFIT/CLOTHING]: This is the clothing/outfit "
            "reference. Use ONLY the garment design — color, fabric, pattern, "
            "neckline, sleeve length, and overall styling. DO NOT copy the "
            "pose, body position, arm placement, or framing of the person in "
            "this reference image; the generated person must stand in the "
            "attention pose specified in the main prompt. "
            + _strength_phrase("outfit", outfit_strength)
        )
        contents.append(Image.open(outfit_ref_path).convert("RGB"))
        has_ref = True
    if style_ref_path and os.path.exists(style_ref_path):
        contents.append(
            "[Reference image — STYLE]: This is a visual-style/mood reference. "
            "Match its lighting, color grading, and overall aesthetic."
        )
        contents.append(Image.open(style_ref_path).convert("RGB"))
        has_ref = True
    if outfit_text and outfit_text.strip():
        contents.append(
            "[Outfit description (text)]: Dress the generated person in the "
            "following outfit (apply to clothing design only — pose remains "
            "the attention pose specified in the main prompt): "
            + outfit_text.strip()
        )

    def _do():
        return client.models.generate_content(
            model=GEMINI_IMAGE_MODEL,
            contents=contents,
            config=_build_gemini_image_config(
                target_size,
                sys_instruction,
                seed=seed,
                temperature=temperature,
                image_size=image_size,
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
    outfit_text: Optional[str] = None,
) -> str:
    """Assemble the body prompt — descriptive text only.

    Strength clauses are NOT included here anymore; they now ride next to
    the image they reference (in _sync_generate's interleaved contents).
    outfit_text is forwarded through, but for layout consistency the
    generator also adds a separate "[Outfit description (text)]:" labeled
    block in contents — keeping it in the body too gives Gemini two passes
    at the cue.
    """
    parts = [
        "Portrait photo of an AI shopping host. 9:16 vertical frame, studio "
        "lighting, photorealistic portrait. Background must be a clean, solid "
        "beige / cream tone — no props, no furniture, no text, no logos. "
        # Medium shot is the sweet spot for the downstream FlashTalk pipeline:
        # face takes ~30% of frame (strong lip-sync signal) AND upper-body
        # motion reads natural. Full body shrinks the face so lip-sync drops,
        # and closeup leaves Step 2 re-framing no room to pull back. Pinning
        # it here stops Gemini's default from drifting between candidates.
        "Shot framing: MEDIUM SHOT, knee-up crop. The frame ends just above "
        "the knees — the lower legs and feet MUST be out of frame. Do NOT "
        "render a full-body shot. Face and upper body occupy the center of "
        "the frame; hands (resting at the thighs) are visible at the bottom "
        "of the frame. "
        "Pose MUST be a strict attention pose for the visible upper body: "
        "facing the camera straight on, shoulders level, both arms hanging "
        "straight down naturally at the sides with hands resting next to the "
        "thighs. (Legs are out of frame but the stance is feet-together, "
        "weight evenly distributed — not contrapposto, not walking.) Do NOT "
        "use hands-on-hips, crossed arms, hand-in-pocket, or any other "
        "styled/posed gesture. "
        "Exactly one person in frame."
    ]
    if text_prompt:
        parts.append(text_prompt)
    if builder:
        suffix = [f"{k}: {v}" for k, v in builder.items() if v]
        if suffix:
            parts.append("Attributes: " + ", ".join(suffix))
    if extra_prompt:
        parts.append(extra_prompt)
    if outfit_text and outfit_text.strip():
        parts.append("Outfit description: " + outfit_text.strip())
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
        "Generate a single person (AI shopping host). "
        # Pose is a hard constraint — outfit reference images often show the
        # model in editorial/dynamic poses (hands on hips, walking, leaning),
        # and Gemini will copy that pose by default. Forcing attention pose
        # at the system level overrides any pose leak from the outfit ref so
        # the generated host always faces forward with arms at sides — what
        # the downstream FlashTalk lip-sync pipeline expects.
        "FRAMING: medium shot, knee-up crop. The frame MUST end just above "
        "the knees — never render a full-body shot. Lower legs and feet are "
        "out of frame. "
        "POSE: the person MUST be in a strict attention pose for the visible "
        "upper body — facing the camera straight on, shoulders level, both "
        "arms hanging straight down naturally at the sides with hands "
        "resting next to the thighs (hands visible at the bottom of the "
        "frame). Do NOT use hands-on-hips, crossed arms, hand-in-pocket, "
        "walking, leaning, or any other styled pose, even if a reference "
        "image shows one — the outfit reference is for clothing design only, "
        "never for pose or framing. "
        # Background is a hard constraint — the downstream FlashTalk pipeline
        # composites the host onto scene backgrounds later, so a plain beige
        # studio backdrop makes rembg extraction clean. Anything else
        # (props, furniture, outdoor scenes) breaks Step 2 composites.
        "BACKGROUND: a plain, solid beige / cream / off-white studio backdrop. "
        "No props, no furniture, no plants, no windows, no text, no logos, "
        "no patterns — the background must be a uniform soft beige color. "
        "Focus on face and outfit clarity. "
        "Photorealistic portrait. No watermarks."
    )
    if negative_prompt:
        base += f"\n\nAvoid the following in the output: {negative_prompt}"
    return base
