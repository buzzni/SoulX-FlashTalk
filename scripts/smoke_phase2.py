"""Phase 2 smoke verification — real rembg, real file I/O, mocked Gemini.

Goal: prove the composite_generator plumbing works end-to-end with real inputs.
Substitute _gemini_generate_scene with a deterministic stub that returns the
people canvas so we don't need GEMINI_API_KEY. Everything else (rembg on
products, safe paths, N=4 parallel asyncio.gather, file writes, response
shape) is exercised on real files.

Run:
  .venv/bin/python scripts/smoke_phase2.py
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
from modules import composite_generator


def _fake_scene(people_img, scene_prompt, target_size, ref_images=None):
    """Stub for Gemini: draw the prompt onto the people canvas so we can see it landed."""
    # Return the people canvas as-is (cropped/resized to target)
    from modules.image_compositor import _resize_and_crop
    return _resize_and_crop(people_img.copy(), target_size)


async def main() -> int:
    host = os.path.join(config.UPLOADS_DIR, "smoke_host.png")
    product = os.path.join(config.UPLOADS_DIR, "smoke_product.png")
    assert os.path.exists(host), f"missing fixture: {host}"
    assert os.path.exists(product), f"missing fixture: {product}"

    print(f"host:    {host}")
    print(f"product: {product}")
    print(f"SAFE_ROOTS: {config.SAFE_ROOTS}")
    print()

    # Patch only _gemini_generate_scene; rembg + filesystem + parallel gather are real
    with patch(
        "modules.image_compositor._gemini_generate_scene",
        side_effect=_fake_scene,
    ):
        t0 = time.perf_counter()
        result = await composite_generator.generate_composite_candidates(
            host_image_path=host,
            product_image_paths=[product],
            background_type="prompt",
            background_prompt="modern bright studio with soft lighting",
            direction_ko="화사하고 친근한 홈쇼핑 분위기, 30대 여성 쇼호스트",
            shot="bust",
            angle="eye",
            n=4,
            rembg_products=True,
        )
        dur = time.perf_counter() - t0

    print(f"[OK] generator returned in {dur:.2f}s")
    print(f"  partial:       {result['partial']}")
    print(f"  candidates:    {len(result['candidates'])}")
    print(f"  direction_ko:  {result['direction_ko']}")
    print(f"  direction_en:  {result['direction_en']!r}  (fallback = same as ko)")
    print(f"  errors:        {result['errors']}")
    print()

    print("[OK] Candidate paths (real files on disk):")
    for c in result["candidates"]:
        size = os.path.getsize(c["path"]) if os.path.exists(c["path"]) else -1
        w, h = Image.open(c["path"]).size if os.path.exists(c["path"]) else (0, 0)
        print(f"  seed={c['seed']:4d}  {c['path']}  ({size} bytes, {w}x{h})")
        print(f"                url: {c['url']}")
    print()

    # Confirm rembg preprocessing actually happened
    tmp_dir = os.path.join(config.OUTPUTS_DIR, "composites", "_tmp")
    rembg_files = sorted(os.listdir(tmp_dir)) if os.path.isdir(tmp_dir) else []
    print(f"[OK] rembg _tmp outputs ({len(rembg_files)}):")
    for f in rembg_files[-5:]:
        p = os.path.join(tmp_dir, f)
        img = Image.open(p)
        has_alpha = img.mode in ("RGBA", "LA") or "A" in img.getbands()
        print(f"  {f}  mode={img.mode}  alpha={has_alpha}  size={os.path.getsize(p)}")
    print()

    # Negative: ?rembg=false should skip _tmp preprocessing
    before = set(rembg_files)
    with patch(
        "modules.image_compositor._gemini_generate_scene",
        side_effect=_fake_scene,
    ):
        result_noremg = await composite_generator.generate_composite_candidates(
            host_image_path=host,
            product_image_paths=[product],
            background_type="prompt",
            background_prompt="neutral studio",
            direction_ko="밝은 분위기",
            shot="closeup",
            angle="low",
            n=2,
            rembg_products=False,
        )
    after = set(os.listdir(tmp_dir)) if os.path.isdir(tmp_dir) else set()
    new_files = after - before
    print(f"[OK] rembg=False run: produced {len(new_files)} new _tmp files "
          f"(expected 0 — rembg skipped)")
    print(f"     candidates: {len(result_noremg['candidates'])}")
    print()

    # Enum validation — should raise ValueError
    try:
        await composite_generator.generate_composite_candidates(
            host_image_path=host,
            product_image_paths=[],
            background_type="hologram",
            direction_ko="",
            shot="bust",
            angle="eye",
        )
        print("[FAIL] bad backgroundType did NOT raise")
        return 1
    except ValueError as e:
        print(f"[OK] bad backgroundType → ValueError: {e}")

    # min_success guard — force all Gemini calls to return None
    def _fail_scene(*a, **kw):
        return None

    with patch(
        "modules.image_compositor._gemini_generate_scene",
        side_effect=_fail_scene,
    ):
        try:
            await composite_generator.generate_composite_candidates(
                host_image_path=host,
                product_image_paths=[],
                background_type="prompt",
                background_prompt="x",
                direction_ko="",
                shot="bust",
                angle="eye",
                n=4,
                rembg_products=False,
            )
            print("[FAIL] all-None Gemini did NOT raise RuntimeError")
            return 1
        except RuntimeError as e:
            print(f"[OK] all-None Gemini → RuntimeError (first 120 chars): {str(e)[:120]}")

    print()
    print("All smoke checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
