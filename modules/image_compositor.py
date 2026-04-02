"""
Image Compositor Module
Pre-processes host and background images before FlashTalk generation.

Approach:
  1. rembg: extract people from host images (background removal)
  2. PIL: place people on white canvas with consistent scale
  3. Gemini: generate a natural scene around the people based on a text prompt
"""

import os
import logging
import uuid
from io import BytesIO
from PIL import Image
from typing import Optional, Tuple, List, Dict

logger = logging.getLogger(__name__)

_gemini_client = None
_rembg_session = None


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
) -> Optional[Image.Image]:
    """Send people image + prompt + optional reference images to Gemini."""
    from google.genai import types

    try:
        client = _get_gemini_client()

        # Build prompt based on whether reference images are provided
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
                "- Keep the people's SIZE EXACTLY as shown. Do NOT resize or reshape them.\n"
                "- Replace ONLY the white background with the described scene.\n"
                "- Incorporate elements from the reference images naturally into the scene.\n"
                "- Add natural lighting, shadows, and reflections matching the scene.\n"
                "- The result should look like a real photograph.\n"
                "- Do NOT alter the people in any way.\n"
                "- Do NOT add any text, letters, words, logos, watermarks, or captions anywhere in the image.\n"
                "- Keep the background SYMMETRIC left-to-right as much as possible."
            )
        else:
            full_prompt = (
                "Here is an image of people on a white background.\n\n"
                f"Scene description: {scene_prompt}\n\n"
                "Task: Generate a new image with these EXACT same people in the described scene.\n\n"
                "STRICT RULES:\n"
                "- Keep each person's face, body, clothing, and proportions EXACTLY as shown.\n"
                "- Keep the people's positions (left/right) EXACTLY as shown.\n"
                "- Keep the people's SIZE EXACTLY as shown. Do NOT resize or reshape them.\n"
                "- Replace ONLY the white background with the described scene.\n"
                "- Add natural lighting, shadows, and reflections matching the scene.\n"
                "- The result should look like a real photograph taken at that location.\n"
                "- Do NOT alter the people in any way.\n"
                "- Do NOT add any text, letters, words, logos, watermarks, or captions anywhere in the image.\n"
                "- Keep the background SYMMETRIC left-to-right as much as possible."
            )

        # Build contents: prompt + people image + reference images
        contents = [full_prompt, _resize_for_api(people_img)]
        if reference_images:
            for ref_img in reference_images:
                contents.append(_resize_for_api(ref_img.convert("RGB")))

        response = client.models.generate_content(
            model="gemini-3-pro-image-preview",
            contents=contents,
            config=types.GenerateContentConfig(
                response_modalities=["Text", "Image"],
            ),
        )

        for part in response.candidates[0].content.parts:
            if part.inline_data is not None:
                result = Image.open(BytesIO(part.inline_data.data)).convert("RGB")
                result = result.resize(target_size, Image.LANCZOS)
                logger.info("Gemini scene generation successful")
                return result

        logger.warning("Gemini response contained no image")
        return None
    except Exception as e:
        logger.error(f"Gemini scene generation failed: {e}")
        return None


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
            resized = result.resize(target_size, Image.LANCZOS)
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
        "- Include natural studio lighting, appropriate for placing people later.\n"
        "- Make the background look like a professional broadcast environment.\n"
        "- Do NOT add any text, letters, words, logos, or watermarks.\n"
        "- The background should be suitable for two hosts standing side by side.\n"
        "- Frame the shot as a wide medium shot at waist-to-head level."
    )

    try:
        client = _get_gemini_client()

        contents = [full_prompt]
        if reference_image_paths:
            ref_images = [Image.open(p).convert("RGB") for p in reference_image_paths if os.path.exists(p)]
            for ref in ref_images:
                contents.append(_resize_for_api(ref))

        response = client.models.generate_content(
            model="gemini-3-pro-image-preview",
            contents=contents,
            config=types.GenerateContentConfig(
                response_modalities=["Text", "Image"],
            ),
        )

        for part in response.candidates[0].content.parts:
            if part.inline_data is not None:
                result = Image.open(BytesIO(part.inline_data.data)).convert("RGB")
                result = result.resize(target_size, Image.LANCZOS)
                out_path = os.path.join(output_dir, f"bg_only_{uuid.uuid4().hex[:8]}.png")
                result.save(out_path, "PNG")
                logger.info(f"Background-only image generated: {out_path}")
                return out_path

        logger.warning("Gemini returned no image for background-only generation")
        return None
    except Exception as e:
        logger.error(f"Background-only generation failed: {e}")
        return None


def release_models():
    """Release loaded models to free memory."""
    global _gemini_client, _rembg_session
    _gemini_client = None
    _rembg_session = None
    logger.info("Image compositor models released")
