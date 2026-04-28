"""Generation job handlers — adapters from /api/jobs input_blob to the
JobRunner event stream.

The runner expects an async generator yielding events of shape:
  {"type": "candidate", "variant": <dict>}
  {"type": "done", "batch_id": <str>, "prev_selected_image_id": <str|None>}
  {"type": "fatal", "error": <str>}

The existing host_generator / composite_generator emit a similar but
not-identical event shape (eng-spec legacy: type=candidate|error|done
with seed/path/url). These adapters translate.
"""
from __future__ import annotations

import logging
from typing import AsyncIterator, Optional

from utils.security import safe_upload_path

logger = logging.getLogger(__name__)


def _image_id_from_path(path: str) -> str:
    import os
    name = os.path.basename(path)
    if name.endswith(".png"):
        name = name[:-4]
    return name


async def host_job_handler(
    job_id: str, blob: dict,
) -> AsyncIterator[dict]:
    """Adapt POST /api/jobs (kind='host') input into JobRunner events.

    Path fields were already validated at POST time, but re-resolving here
    is cheap and matches the eng-spec §8 defense-in-depth posture.
    """
    from modules.host_generator import stream_host_candidates

    seeds = blob.get("seeds")
    parsed_seeds: Optional[list[int]] = (
        list(seeds) if isinstance(seeds, list) else None
    )

    mode = blob.get("mode") or "v1"
    face = (
        safe_upload_path(blob["faceRefPath"])
        if blob.get("faceRefPath") else None
    )
    outfit = (
        safe_upload_path(blob["outfitRefPath"])
        if blob.get("outfitRefPath") else None
    )
    style = (
        safe_upload_path(blob["styleRefPath"])
        if blob.get("styleRefPath") else None
    )

    async for evt in stream_host_candidates(
        mode=mode,
        text_prompt=blob.get("prompt"),
        face_ref_path=face,
        outfit_ref_path=outfit,
        style_ref_path=style,
        extra_prompt=blob.get("extraPrompt"),
        builder=blob.get("builder"),
        negative_prompt=blob.get("negativePrompt"),
        face_strength=blob.get("faceStrength", 0.7),
        outfit_strength=blob.get("outfitStrength", 0.7),
        outfit_text=blob.get("outfitText"),
        seeds=parsed_seeds,
        image_size=blob.get("imageSize", "1K"),
        n=blob.get("n", 4),
        temperature=blob.get("temperature"),
    ):
        async for translated in _translate_legacy_event(job_id, evt):
            yield translated


async def composite_job_handler(
    job_id: str, blob: dict,
) -> AsyncIterator[dict]:
    """Adapt POST /api/jobs (kind='composite') input into JobRunner events."""
    from modules.composite_generator import stream_composite_candidates

    host_path = safe_upload_path(blob["hostImagePath"])
    products_raw = blob.get("productImagePaths") or []
    products = [safe_upload_path(p) for p in products_raw]
    bg_upload = (
        safe_upload_path(blob["backgroundUploadPath"])
        if blob.get("backgroundUploadPath") else None
    )
    seeds = blob.get("seeds")
    parsed_seeds: Optional[list[int]] = (
        list(seeds) if isinstance(seeds, list) else None
    )

    async for evt in stream_composite_candidates(
        host_image_path=host_path,
        product_image_paths=products,
        background_type=blob.get("backgroundType", "prompt"),
        background_preset_id=blob.get("backgroundPresetId"),
        background_preset_label=blob.get("backgroundPresetLabel"),
        background_upload_path=bg_upload,
        background_prompt=blob.get("backgroundPrompt"),
        direction_ko=blob.get("direction", ""),
        shot=blob.get("shot", "bust"),
        angle=blob.get("angle", "eye"),
        n=blob.get("n", 4),
        rembg_products=blob.get("rembg", True),
        temperature=blob.get("temperature"),
        seeds=parsed_seeds,
        image_size=blob.get("imageSize", "1K"),
    ):
        async for translated in _translate_legacy_event(job_id, evt):
            yield translated


async def _translate_legacy_event(
    job_id: str, evt: dict,
) -> AsyncIterator[dict]:
    """Map host_generator/composite_generator events → JobRunner events.

    Legacy shapes:
      candidate: {type, seed, path, url, done, total}
      error:     {type, seed, error}            -- per-slot, non-fatal
      fatal:     {type, error, status?}         -- aborts the stream
      init:      {type, seeds, ...}             -- handshake, ignored here
      done:      {type, success_count, total, partial}

    JobRunner shapes (eng-spec §2.2):
      candidate: {type, variant: {image_id, path, url, seed}}
      done:      {type, batch_id, prev_selected_image_id}
      fatal:     {type, error}
    """
    et = evt.get("type")
    if et == "candidate" and evt.get("path"):
        path = evt["path"]
        yield {
            "type": "candidate",
            "variant": {
                "image_id": _image_id_from_path(path),
                "path": path,
                "url": evt.get("url"),
                "seed": evt.get("seed"),
            },
        }
    elif et == "fatal":
        yield {"type": "fatal", "error": str(evt.get("error", "unknown"))}
    elif et == "done":
        if evt.get("min_success_met") is False:
            yield {
                "type": "fatal",
                "error": f"후보가 부족해요 ({evt.get('success_count', 0)}/{evt.get('total', 0)})",
            }
        else:
            # batch_id and prev_selected_image_id are computed inside
            # mark_ready_with_lifecycle (host_repo.record_batch +
            # cleanup_after_generate). Pass batch_id=job_id so the row
            # has a stable handle even if the legacy generator omits it.
            yield {"type": "done", "batch_id": evt.get("batch_id") or job_id}
    elif et == "error":
        # Per-slot failure — legacy logs it, the new path doesn't have a
        # per-slot error variant, so suppress. The candidate's slot will
        # show as missing in the variants array.
        logger.info(
            "job %s: per-slot error suppressed (legacy event): %s",
            job_id, evt.get("error"),
        )
    # init / unknown types: ignored
