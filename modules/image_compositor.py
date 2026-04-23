"""
Image Compositor Module
Pre-processes host and background images before FlashTalk generation.

Approach:
  1. rembg: extract people from host images (background removal)
  2. PIL: place people on white canvas with consistent scale
  3. Gemini: generate a natural scene around the people based on a text prompt
"""

import json
import os
import logging
import re
import time
import uuid
from io import BytesIO
from PIL import Image
from typing import Optional, Tuple, List, Dict

logger = logging.getLogger(__name__)

# Phase 0 T-GM1: Flash swap (~1/5 cost vs Pro, 9:16 portrait capable)
GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image-preview"

_gemini_client = None
_rembg_session = None

# Retry config for transient Gemini failures. The caller already has
# min_success=2 tolerance for the slowest-N-of-4 pattern, but per-candidate
# retries materially improve the hit rate when Google has a bad minute.
_GEMINI_RETRY_MAX_ATTEMPTS = 2  # 1 initial + 1 retry
_GEMINI_RETRY_BACKOFF_S = (1.0, 3.0)  # sleeps before attempts 2, 3, ...


def _call_gemini_with_retry(fn, *, attempts: int = _GEMINI_RETRY_MAX_ATTEMPTS):
    """Invoke a zero-arg Gemini callable with retry on transient errors.

    Retries on category ∈ {quota, transient, timeout}. Does NOT retry on
    safety/other/empty — those are deterministic for the given input and
    re-trying wastes cost.
    """
    import time as _time

    last_err: Optional[GeminiImageError] = None
    for i in range(attempts):
        try:
            return fn()
        except GeminiImageError as e:
            last_err = e
            if e.category not in ("quota", "transient", "timeout"):
                raise
            if i >= attempts - 1:
                raise
            sleep = _GEMINI_RETRY_BACKOFF_S[min(i, len(_GEMINI_RETRY_BACKOFF_S) - 1)]
            logger.warning("Gemini %s — retrying after %.1fs (attempt %d/%d)",
                           e.category, sleep, i + 2, attempts)
            _time.sleep(sleep)
        except Exception as e:
            # SDK exceptions — wrap and decide
            classified = _classify_sdk_exception(e)
            last_err = classified
            if classified.category not in ("quota", "transient", "timeout"):
                raise classified
            if i >= attempts - 1:
                raise classified
            sleep = _GEMINI_RETRY_BACKOFF_S[min(i, len(_GEMINI_RETRY_BACKOFF_S) - 1)]
            logger.warning("Gemini %s (%s) — retrying after %.1fs",
                           classified.category, type(e).__name__, sleep)
            _time.sleep(sleep)
    if last_err:
        raise last_err
    raise GeminiImageError("Unknown retry exhaustion", category="other")


def _derive_aspect_ratio(target_size: Tuple[int, int]) -> str:
    """Phase 0 T-GM2: derive aspect_ratio from (width, height).

    Returns '9:16' for portrait, '16:9' for landscape, '1:1' for square.
    Never hardcoded — always reflects target_size to avoid landscape pipeline breakage.
    """
    w, h = target_size
    if h > w * 1.3:
        return "9:16"
    if w > h * 1.3:
        return "16:9"
    return "1:1"


def _sanitize_user_prompt(text: str) -> str:
    """Phase 0 T-GM3c: strip prompt-injection delimiter tokens from user input.

    Preserves paragraph breaks (\\n\\n); collapses only \\n{3,} → \\n\\n.
    Removes triple-quote / fence tokens that could break out of system_instruction.
    """
    if not text:
        return ""
    # Strip dangerous delimiter tokens
    text = re.sub(r"`{3,}|\"{3,}|'{3,}|<\|.*?\|>|---\n", " ", text)
    # Preserve \n\n, collapse 3+
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _build_gemini_image_config(
    target_size: Tuple[int, int],
    system_instruction: Optional[str] = None,
    thinking_minimal: bool = True,
    seed: Optional[int] = None,
    temperature: Optional[float] = None,
):
    """Centralized Gemini image-gen config. Phase 0 T-GM2/3/3b/4 + param audit.

    Args:
        target_size: (width, height) — derives aspect_ratio.
        system_instruction: per-call system prompt (anti-injection + behavioral).
        thinking_minimal: always True for Flash; kept as param for Pro swap.
        seed: Gemini sampling seed — same seed + same inputs = same output.
            None → stochastic. Pass the per-candidate seed here for
            reproducibility across re-runs.
        temperature: sampling variance. None → model default (~1.0).
            Lower = more predictable, higher = more variation. UI exposes
            this as 0.4 / 0.7 / 1.0 Segmented.

    Note: person_generation and media_resolution are intentionally absent —
    the Gemini API backend rejects the former (Vertex-only) and the
    gemini-3.1-flash-image-preview model rejects the latter (400
    INVALID_ARGUMENT on all values). Safety via safety_settings.
    """
    from google.genai import types

    aspect = _derive_aspect_ratio(target_size)
    safety = [
        types.SafetySetting(
            category=c,
            threshold=types.HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        )
        for c in (
            types.HarmCategory.HARM_CATEGORY_HARASSMENT,
            types.HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        )
    ]
    kwargs = dict(
        response_modalities=["Text", "Image"],
        image_config=types.ImageConfig(aspect_ratio=aspect, image_size="1K"),
        safety_settings=safety,
    )
    if thinking_minimal:
        kwargs["thinking_config"] = types.ThinkingConfig(thinking_level="minimal")
    if system_instruction:
        kwargs["system_instruction"] = system_instruction
    if seed is not None:
        kwargs["seed"] = int(seed)
    if temperature is not None:
        kwargs["temperature"] = float(temperature)
    return types.GenerateContentConfig(**kwargs)


def write_generation_metadata(image_path: str, metadata: Dict) -> Optional[str]:
    """Write a .meta.json sidecar next to the generated PNG capturing what
    was actually sent to Gemini. Makes "this candidate came out weird"
    reports reproducible — replay the exact request with the same seed +
    temperature + prompt + system_instruction and you'll see the same
    output (modulo model-side non-determinism beyond the seed).

    `metadata` is a free-form dict; this helper adds a timestamp and uses
    json.dumps with default=str so Enum/Path values serialize cleanly.
    Failures are swallowed — metadata is diagnostic-only, should never
    break the happy path.
    """
    if not image_path:
        return None
    try:
        out = {**metadata, "generated_at": time.time(), "generated_iso": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
        meta_path = image_path + ".meta.json"
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2, default=str)
        return meta_path
    except Exception as e:
        logger.warning("Failed to write metadata sidecar for %s: %s", image_path, e)
        return None


class GeminiImageError(Exception):
    """Raised when Gemini image generation fails in a known/categorized way.

    .category is one of: "safety" | "quota" | "timeout" | "empty" | "other".
    Callers surface this to end users via humanizeError / SSE events so the
    UI can say "안전 필터에 걸렸어요" vs a generic 503.
    """
    def __init__(self, message: str, category: str = "other", detail: dict = None):
        super().__init__(message)
        self.category = category
        self.detail = detail or {}


def _diagnose_empty_response(response) -> GeminiImageError:
    """Inspect a Gemini response that produced no image, return a
    categorized GeminiImageError with finish_reason + safety ratings.

    Use when the response arrived (no exception) but inline_data is missing —
    the single most useful debug log we can emit without hitting the API
    twice. Previously we logged a flat "Gemini returned no image" and users
    had no idea if it was safety-blocked, truncated, or genuinely empty.
    """
    candidates = getattr(response, "candidates", None) or []
    prompt_feedback = getattr(response, "prompt_feedback", None)

    if not candidates:
        block_reason = getattr(prompt_feedback, "block_reason", None)
        logger.warning(
            "Gemini returned no candidates; prompt_feedback.block_reason=%s",
            block_reason,
        )
        if block_reason:
            return GeminiImageError(
                f"Prompt blocked by Gemini: {block_reason}",
                category="safety",
                detail={"block_reason": str(block_reason)},
            )
        return GeminiImageError(
            "Gemini returned no candidates",
            category="empty",
        )

    cand = candidates[0]
    finish = getattr(cand, "finish_reason", None)
    safety = getattr(cand, "safety_ratings", None) or []
    safety_summary = [
        {"category": str(getattr(r, "category", None)), "probability": str(getattr(r, "probability", None))}
        for r in safety
    ]
    logger.warning(
        "Gemini produced no image data: finish_reason=%s, safety_ratings=%s",
        finish,
        safety_summary,
    )

    finish_str = str(finish) if finish else ""
    if "SAFETY" in finish_str.upper():
        return GeminiImageError(
            "Image blocked by safety filter",
            category="safety",
            detail={"finish_reason": finish_str, "safety": safety_summary},
        )
    if "MAX_TOKENS" in finish_str.upper():
        return GeminiImageError(
            "Output truncated",
            category="truncated",
            detail={"finish_reason": finish_str},
        )
    return GeminiImageError(
        f"No image in response (finish_reason={finish_str or 'unknown'})",
        category="empty",
        detail={"finish_reason": finish_str},
    )


def _classify_sdk_exception(exc: BaseException) -> GeminiImageError:
    """Map google.genai SDK exceptions to our category taxonomy."""
    name = type(exc).__name__
    msg = str(exc)
    lower = msg.lower()
    if "429" in msg or "rate" in lower or "quota" in lower:
        return GeminiImageError(f"Rate limit / quota: {msg}", category="quota")
    if "timeout" in lower or "deadline" in lower or name == "TimeoutError":
        return GeminiImageError(f"Gemini timeout: {msg}", category="timeout")
    if "503" in msg or "unavailable" in lower:
        return GeminiImageError(f"Gemini temporarily unavailable: {msg}", category="transient")
    return GeminiImageError(f"{name}: {msg}", category="other")


def _get_gemini_client():
    """Lazy-load Gemini API client."""
    global _gemini_client
    if _gemini_client is None:
        from google import genai
        api_key = os.environ.get("GEMINI_API_KEY", "")
        if not api_key:
            from dotenv import load_dotenv
            load_dotenv()
            api_key = os.environ.get("GEMINI_API_KEY", "")
        if not api_key:
            raise ValueError("GEMINI_API_KEY not found in environment or .env")
        _gemini_client = genai.Client(api_key=api_key)
        logger.info("Gemini client initialized")
    return _gemini_client


def _get_rembg_session():
    """Lazy-load rembg session."""
    global _rembg_session
    if _rembg_session is None:
        from rembg import new_session
        _rembg_session = new_session("u2net")
        logger.info("rembg session loaded (u2net)")
    return _rembg_session


def _remove_bg(image_path: str) -> Image.Image:
    """Remove background using rembg. Returns RGBA."""
    from rembg import remove
    session = _get_rembg_session()
    img = Image.open(image_path).convert("RGB")
    return remove(img, session=session)


def _resize_for_api(img, max_side=1024):
    """Resize for Gemini API."""
    w, h = img.size
    if max(w, h) <= max_side:
        return img
    ratio = max_side / max(w, h)
    return img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)


def _resize_and_crop(img: Image.Image, target_size: Tuple[int, int]) -> Image.Image:
    """Resize while preserving aspect ratio, then center-crop to target_size.

    This avoids stretching/squishing that happens with a direct resize.
    target_size is (width, height).
    """
    tw, th = target_size
    w, h = img.size

    # Scale so image covers target (fill, not fit)
    scale = max(tw / w, th / h)
    new_w = int(w * scale)
    new_h = int(h * scale)
    img = img.resize((new_w, new_h), Image.LANCZOS)

    # Center crop
    left = (new_w - tw) // 2
    top = (new_h - th) // 2
    return img.crop((left, top, left + tw, top + th))


def _apply_edge_fade(img: Image.Image, fade_px: int, side: str = "right") -> Image.Image:
    """Apply a soft gradient fade on one edge to blend with adjacent panel.

    Fades from full image to a neutral averaged color on the seam edge,
    so when two panels sit side by side, there's no hard brightness/color jump.

    Args:
        img: RGB image
        fade_px: width of the fade zone in pixels
        side: "left" or "right" - which edge to fade
    """
    import numpy as np

    if fade_px <= 0:
        return img

    arr = np.array(img, dtype=np.float32)
    h, w, _ = arr.shape
    fade_px = min(fade_px, w // 4)  # don't fade more than 25% of width

    # Compute the average color of the fade zone for smooth transition
    if side == "right":
        edge_strip = arr[:, w - fade_px:, :]
    else:
        edge_strip = arr[:, :fade_px, :]
    edge_avg = edge_strip.mean(axis=(0, 1), keepdims=True)  # (1, 1, 3)

    # Create gradient alpha: 1.0 (full image) → 0.7 (slightly faded at edge)
    # We don't go to 0 (black) because we want color continuity, just softening
    gradient = np.linspace(1.0, 0.85, fade_px).reshape(1, -1, 1)

    if side == "right":
        fade_zone = arr[:, w - fade_px:, :]
        arr[:, w - fade_px:, :] = fade_zone * gradient + edge_avg * (1 - gradient)
    else:
        gradient = gradient[:, ::-1, :]  # reverse: edge → inner
        fade_zone = arr[:, :fade_px, :]
        arr[:, :fade_px, :] = fade_zone * gradient + edge_avg * (1 - gradient)

    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def _build_people_canvas(host_rgbas: List[Image.Image], canvas_size: Tuple[int, int], scale: float = 0.75) -> Image.Image:
    """Place extracted people on white canvas with consistent scale.

    Returns RGB image with people on white background.
    """
    w, h = canvas_size
    canvas = Image.new("RGBA", canvas_size, (255, 255, 255, 255))

    person_h = int(h * scale)
    num = len(host_rgbas)

    for i, rgba in enumerate(host_rgbas):
        aspect = rgba.width / rgba.height
        person_w = int(person_h * aspect)
        resized = rgba.resize((person_w, person_h), Image.LANCZOS)

        if num == 1:
            cx = w // 2
        elif num == 2:
            # Position at 25% and 75% of canvas.
            # With 2x wide canvas (1440) and 50% crop (720 each),
            # each person at 25%/75% → centered in their crop half.
            # Compositor then center-crops 720→360, person stays at center.
            cx = int(w * (0.25 if i == 0 else 0.75))
        else:
            cx = int(w * (i + 1) / (num + 1))

        x = max(0, min(cx - person_w // 2, w - person_w))
        y = h - person_h
        canvas.paste(resized, (x, y), resized)

    return canvas.convert("RGB")


def _gemini_generate_scene(
    people_img: Image.Image,
    scene_prompt: str,
    target_size: Tuple[int, int],
    reference_images: Optional[List[Image.Image]] = None,
    seed: Optional[int] = None,
    temperature: Optional[float] = None,
) -> Optional[Image.Image]:
    """Send people image + prompt + optional reference images to Gemini."""
    from google.genai import types

    try:
        client = _get_gemini_client()

        # Build prompt based on whether reference images are provided
        # Common lighting/shadow/perspective rules
        lighting_rules = (
            "\n\nLIGHTING & SHADOW RULES:\n"
            "- Determine the main light source direction from the scene description and reference images.\n"
            "- Cast realistic shadows on the ground/floor beneath each person, consistent with the light source direction and angle.\n"
            "- Shadow length and softness must match the lighting distance (close light = sharp shadow, distant light = soft shadow).\n"
            "- Apply subtle ambient occlusion where the person's feet meet the ground (contact shadow).\n"
            "- Match the color temperature of light hitting the person to the scene's ambient lighting (warm/cool/mixed).\n"
            "- Add subtle rim lighting or backlighting on the person's edges if the scene has strong directional or back lights.\n"
            "\nPERSPECTIVE & SPATIAL RULES:\n"
            "- The person's feet must be firmly grounded on the floor plane, matching the scene's perspective vanishing point.\n"
            "- The camera angle (eye-level, slightly low, slightly high) must be consistent between the person and the background.\n"
            "- The person's scale must be realistic relative to nearby objects (desks, screens, furniture) in the scene.\n"
            "- Ensure correct depth-of-field: if the background has bokeh/blur, apply matching subtle depth cues around the person's edges.\n"
            "- CRITICAL: Preserve the person's EXACT height-to-width ratio (aspect ratio). Do NOT compress or stretch the person vertically or horizontally.\n"
        )

        if reference_images:
            full_prompt = (
                "I am providing the following images:\n"
                "- Image 1: People on a white background (these are the people to place in the scene).\n"
            )
            for i in range(len(reference_images)):
                full_prompt += f"- Image {i+2}: A reference image to incorporate into the scene.\n"
            full_prompt += (
                f"\nScene description: {scene_prompt}\n\n"
                "Task: Generate a new image with these EXACT same people in the described scene. "
                "Use the reference images as visual context for the scene (e.g., products, set design, branding).\n\n"
                "STRICT RULES:\n"
                "- Keep each person's face, body, clothing, and proportions EXACTLY as shown in Image 1.\n"
                "- Keep the people's positions (left/right) EXACTLY as shown in Image 1.\n"
                "- Keep the people's SIZE and ASPECT RATIO EXACTLY as shown. Do NOT resize, reshape, compress, or stretch them.\n"
                "- Replace ONLY the white background with the described scene.\n"
                "- Incorporate elements from the reference images naturally into the scene.\n"
                "- The result should look like a real photograph.\n"
                "- Do NOT alter the people in any way.\n"
                "- Do NOT add any text, letters, words, logos, watermarks, or captions anywhere in the image.\n"
                "- Keep the background SYMMETRIC left-to-right as much as possible."
                + lighting_rules
            )
        else:
            full_prompt = (
                "Here is an image of people on a white background.\n\n"
                f"Scene description: {scene_prompt}\n\n"
                "Task: Generate a new image with these EXACT same people in the described scene.\n\n"
                "STRICT RULES:\n"
                "- Keep each person's face, body, clothing, and proportions EXACTLY as shown.\n"
                "- Keep the people's positions (left/right) EXACTLY as shown.\n"
                "- Keep the people's SIZE and ASPECT RATIO EXACTLY as shown. Do NOT resize, reshape, compress, or stretch them.\n"
                "- Replace ONLY the white background with the described scene.\n"
                "- The result should look like a real photograph taken at that location.\n"
                "- Do NOT alter the people in any way.\n"
                "- Do NOT add any text, letters, words, logos, watermarks, or captions anywhere in the image.\n"
                "- Keep the background SYMMETRIC left-to-right as much as possible."
                + lighting_rules
            )

        # Build contents: prompt + people image + reference images
        contents = [full_prompt, _resize_for_api(people_img)]
        if reference_images:
            for ref_img in reference_images:
                contents.append(_resize_for_api(ref_img.convert("RGB")))

        system_instruction = (
            "You are a scene generator. Preserve the foreground subjects (people) "
            "from the provided image exactly as-is; only compose the background/scene "
            "around them. Do not add any text, watermarks, or logos. "
            "Keep lighting and shadows consistent across all subjects."
        )
        def _do():
            return client.models.generate_content(
                model=GEMINI_IMAGE_MODEL,
                contents=contents,
                config=_build_gemini_image_config(
                    target_size,
                    system_instruction,
                    seed=seed,
                    temperature=temperature,
                ),
            )
        response = _call_gemini_with_retry(_do)

        candidates = getattr(response, "candidates", None) or []
        if candidates:
            for part in candidates[0].content.parts:
                if part.inline_data is not None:
                    result = Image.open(BytesIO(part.inline_data.data)).convert("RGB")
                    result = _resize_and_crop(result, target_size)
                    logger.info("Gemini scene generation successful")
                    return result

        # Response arrived but no image — diagnose + raise structured error so
        # callers can distinguish safety blocks from generic "no image".
        raise _diagnose_empty_response(response)
    except GeminiImageError:
        raise
    except Exception as e:
        logger.error(f"Gemini scene generation failed: {e}")
        raise _classify_sdk_exception(e)


def compose_agents_together(
    host_image_paths: List[str],
    bg_image_path: str,
    target_size: Tuple[int, int],
    layout: str = "split",
    scene_prompt: str = "",
    reference_image_paths: Optional[List[str]] = None,
    multitalk: bool = False,
) -> Dict[int, str]:
    """Compose multiple agents with Gemini-generated scene.

    1. rembg: extract people
    2. PIL: arrange on canvas
    3. Gemini: generate scene around them using prompt
    4. Crop per agent for split layout

    Args:
        host_image_paths: list of host image paths
        bg_image_path: ignored (kept for API compatibility), prompt used instead
        target_size: (width, height) per agent output
        layout: "split", "switch", "pip"
        scene_prompt: description of the scene/background to generate

    Returns:
        {agent_index: composed_image_path}
    """
    output_dir = os.path.dirname(bg_image_path) if bg_image_path else "uploads"
    os.makedirs(output_dir, exist_ok=True)
    num_agents = len(host_image_paths)

    if not scene_prompt:
        scene_prompt = (
            "A modern, professional TV studio set with soft studio lighting. "
            "Clean and elegant broadcast studio background with subtle blue and white tones. "
            "The scene looks like a professional news or talk show set."
        )

    logger.info(f"Composing {num_agents} agents with Gemini scene generation")

    # Step 1: Extract people
    host_rgbas = [_remove_bg(path) for path in host_image_paths]

    # Step 2: Build canvas.
    # MultiTalk mode: LANDSCAPE canvas for 2 people side-by-side (e.g., 1024x384).
    #   Video model generates at landscape resolution → compositor scales to final output.
    # FlashTalk mode: canvas = 2x width, crop at 50% for each agent.
    target_w, target_h = target_size
    if multitalk:
        # MultiTalk: landscape canvas matching the 480P generation bucket (1024x384)
        # This gives ~512px per person width for much better quality
        canvas_w = 1024
        canvas_h = 384
    elif num_agents >= 2 and layout == "split":
        canvas_w = target_w * 2
        canvas_h = target_h
    else:
        canvas_w = target_w
        canvas_h = target_h
    canvas_size = (canvas_w, canvas_h)

    people_canvas = _build_people_canvas(host_rgbas, canvas_size, scale=0.75)

    # Load reference images if provided
    ref_images = None
    if reference_image_paths:
        ref_images = [Image.open(p).convert("RGB") for p in reference_image_paths if os.path.exists(p)]
        if not ref_images:
            ref_images = None

    # Step 3: Gemini generates scene
    result = _gemini_generate_scene(people_canvas, scene_prompt, canvas_size, ref_images)

    if result is None:
        logger.warning("Gemini failed, using people on white background as fallback")
        result = people_canvas

    # Save full (uncropped) image for preview
    full_path = os.path.join(output_dir, f"composed_full_{uuid.uuid4().hex[:8]}.png")
    result.save(full_path, "PNG")
    logger.info(f"Full scene image saved: {full_path}")

    # Step 4: Crop at 50% → each half = target_w x target_h (proper aspect ratio)
    results = {}
    if num_agents >= 2 and layout == "split":
        half_w = canvas_w // 2  # = target_w
        for i in range(num_agents):
            crop_x = i * half_w
            cropped = result.crop((crop_x, 0, crop_x + half_w, canvas_h))
            out_path = os.path.join(output_dir, f"composed_{uuid.uuid4().hex[:8]}.png")
            cropped.save(out_path, "PNG")
            results[i] = out_path
            logger.info(f"Agent {i}: crop x={crop_x}~{crop_x+half_w}, size={half_w}x{canvas_h}, saved to {out_path}")
    else:
        for i in range(num_agents):
            out_path = os.path.join(output_dir, f"composed_{uuid.uuid4().hex[:8]}.png")
            resized = _resize_and_crop(result, target_size)
            resized.save(out_path, "PNG")
            results[i] = out_path

    results["full"] = full_path
    return results


def compose_agent_image(
    host_image_path: str,
    bg_image_path: str,
    target_size: Tuple[int, int],
    scale: float = 0.75,
    position: str = "center",
    scene_prompt: str = "",
    reference_image_paths: Optional[List[str]] = None,
) -> str:
    """Single agent composition with Gemini scene generation."""
    output_dir = os.path.dirname(bg_image_path) if bg_image_path else "uploads"
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, f"composed_{uuid.uuid4().hex[:8]}.png")

    if not scene_prompt:
        scene_prompt = (
            "A modern, professional TV studio set with soft studio lighting. "
            "Clean and elegant broadcast studio background with subtle blue and white tones."
        )

    host_rgba = _remove_bg(host_image_path)
    people_canvas = _build_people_canvas([host_rgba], target_size, scale=scale)

    ref_images = None
    if reference_image_paths:
        ref_images = [Image.open(p).convert("RGB") for p in reference_image_paths if os.path.exists(p)]
        if not ref_images:
            ref_images = None

    result = _gemini_generate_scene(people_canvas, scene_prompt, target_size, ref_images)

    if result is None:
        logger.warning("Gemini failed, using fallback")
        result = people_canvas

    result.save(output_path, "PNG")
    logger.info(f"Composed image saved: {output_path}")
    return output_path


def compose_agent_on_solid_bg(
    host_image_path: str,
    target_size: Tuple[int, int],
    bg_color: Tuple[int, int, int] = (180, 180, 180),
    scale: float = 0.80,
) -> str:
    """Place a person on a solid color background for easier rembg extraction later.

    Used in alpha-composite mode: simple background makes matting far more accurate.

    Returns path to the saved image.
    """
    output_dir = "uploads"
    os.makedirs(output_dir, exist_ok=True)

    host_rgba = _remove_bg(host_image_path)
    w, h = target_size
    canvas = Image.new("RGB", (w, h), bg_color)

    person_h = int(h * scale)
    aspect = host_rgba.width / host_rgba.height
    person_w = int(person_h * aspect)
    person_resized = host_rgba.resize((person_w, person_h), Image.LANCZOS)

    paste_x = max(0, (w - person_w) // 2)
    paste_y = h - person_h
    canvas.paste(person_resized, (paste_x, paste_y), person_resized)

    out_path = os.path.join(output_dir, f"solid_bg_{uuid.uuid4().hex[:8]}.png")
    canvas.save(out_path, "PNG")
    logger.info(f"Agent on solid bg: {out_path}")
    return out_path


def generate_background_only(
    scene_prompt: str,
    target_size: Tuple[int, int],
    reference_image_paths: Optional[List[str]] = None,
) -> Optional[str]:
    """Generate a background-only image using Gemini (no people).

    Used for alpha-composite mode: shared background + individually extracted agents.

    Returns path to saved background image, or None on failure.
    """
    from google.genai import types

    output_dir = "uploads"
    os.makedirs(output_dir, exist_ok=True)

    if not scene_prompt:
        scene_prompt = (
            "A modern, professional TV studio set with soft studio lighting. "
            "Clean and elegant broadcast studio background with subtle blue and white tones."
        )

    full_prompt = (
        f"Scene description: {scene_prompt}\n\n"
        "Task: Generate a background image for a TV broadcast scene.\n\n"
        "STRICT RULES:\n"
        "- Do NOT include any people, characters, or human figures in the image.\n"
        "- The scene should be an EMPTY background/set with no one in it.\n"
        "- Include natural studio lighting with clear directional light sources, appropriate for placing people later.\n"
        "- Make the background look like a professional broadcast environment.\n"
        "- Do NOT add any text, letters, words, logos, or watermarks.\n"
        "- The background should be suitable for two hosts standing side by side.\n"
        "- Frame the shot as a wide medium shot at waist-to-head level.\n"
        "- The floor should be visible and have a clear ground plane with realistic perspective.\n"
        "- Include subtle light reflections or highlights on the floor to indicate where shadows would naturally fall when people stand there."
    )

    try:
        client = _get_gemini_client()

        contents = [full_prompt]
        if reference_image_paths:
            ref_images = [Image.open(p).convert("RGB") for p in reference_image_paths if os.path.exists(p)]
            for ref in ref_images:
                contents.append(_resize_for_api(ref))

        system_instruction = (
            "Generate only a background scene. No people, no text, no logos. "
            "Match the requested aspect ratio precisely."
        )
        def _do():
            return client.models.generate_content(
                model=GEMINI_IMAGE_MODEL,
                contents=contents,
                config=_build_gemini_image_config(
                    target_size,
                    system_instruction,
                ),
            )
        response = _call_gemini_with_retry(_do)

        candidates = getattr(response, "candidates", None) or []
        if candidates:
            for part in candidates[0].content.parts:
                if part.inline_data is not None:
                    result = Image.open(BytesIO(part.inline_data.data)).convert("RGB")
                    result = _resize_and_crop(result, target_size)
                    out_path = os.path.join(output_dir, f"bg_only_{uuid.uuid4().hex[:8]}.png")
                    result.save(out_path, "PNG")
                    logger.info(f"Background-only image generated: {out_path}")
                    return out_path

        raise _diagnose_empty_response(response)
    except GeminiImageError:
        raise
    except Exception as e:
        logger.error(f"Background-only generation failed: {e}")
        raise _classify_sdk_exception(e)


def release_models():
    """Release loaded models to free memory."""
    global _gemini_client, _rembg_session
    _gemini_client = None
    _rembg_session = None
    logger.info("Image compositor models released")
