"""Phase 2 — POST /api/composite/generate endpoint."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

pytestmark = pytest.mark.phase2


@pytest.fixture
def client(monkeypatch, tmp_path):
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    hosts = outputs / "hosts" / "saved"
    composites = outputs / "composites"
    examples = tmp_path / "examples"
    for d in (uploads, outputs, hosts, composites, examples):
        d.mkdir(parents=True, exist_ok=True)

    import config

    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "HOSTS_DIR", str(hosts))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(examples))
    monkeypatch.setattr(config, "SAFE_ROOTS", (str(uploads), str(outputs), str(examples)))

    # Create a stub host image + 2 product images inside uploads so safe_upload_path resolves
    host = uploads / "host_1.png"
    host.write_bytes(b"\x89PNG\r\n\x1a\n")
    prod1 = uploads / "prod_a.png"
    prod1.write_bytes(b"\x89PNG\r\n\x1a\n")
    prod2 = uploads / "prod_b.png"
    prod2.write_bytes(b"\x89PNG\r\n\x1a\n")

    from fastapi.testclient import TestClient
    import app as app_module

    with TestClient(app_module.app) as client:
        client._host = str(host)
        client._products = [str(prod1), str(prod2)]
        yield client


def _fake_result(n=4):
    """Fake generate_composite_candidates() return value.

    PR S3+ C6a: the endpoint now uploads each candidate's local PNG
    into media_store, so the mock points at real on-disk files inside
    the test's OUTPUTS_DIR/composites (created lazily here) — was
    `/tmp/comp_s*.png` before.
    """
    import os
    import config
    composites_dir = os.path.join(config.OUTPUTS_DIR, "composites")
    os.makedirs(composites_dir, exist_ok=True)
    candidates = []
    for s in (10, 42, 77, 128)[:n]:
        p = os.path.join(composites_dir, f"comp_s{s}.png")
        if not os.path.exists(p):
            with open(p, "wb") as f:
                f.write(b"\x89PNG\r\n\x1a\n")
        candidates.append({
            "seed": s,
            "path": p,
            "url": f"/api/files/composites/comp_s{s}.png",
        })
    return {
        "candidates": candidates,
        "partial": False,
        "errors": None,
        "direction_ko": "밝고 친근한 홈쇼핑 분위기",
        "direction_en": "bright, friendly home-shopping atmosphere",
    }


def test_happy_path_returns_candidates(client):
    """Mock generator; verify endpoint returns 4 candidates."""
    with patch(
        "modules.composite_generator.generate_composite_candidates",
        new=AsyncMock(return_value=_fake_result()),
    ):
        r = client.post(
            "/api/composite/generate",
            data={
                "hostImagePath": client._host,
                "productImagePaths": json.dumps(client._products),
                "backgroundType": "prompt",
                "backgroundPrompt": "studio with neutral backdrop",
                "direction": "밝고 친근한 홈쇼핑 분위기",
                "shot": "bust",
                "angle": "eye",
                "n": 4,
            },
        )
    assert r.status_code == 200, r.text
    data = r.json()
    assert len(data["candidates"]) == 4
    assert data["partial"] is False
    assert data["direction_ko"] == "밝고 친근한 홈쇼핑 분위기"


def test_rembg_default_on_for_product_images(client):
    """No ?rembg param → generator called with rembg_products=True."""
    fake = AsyncMock(return_value=_fake_result())
    with patch("modules.composite_generator.generate_composite_candidates", new=fake):
        r = client.post(
            "/api/composite/generate",
            data={
                "hostImagePath": client._host,
                "productImagePaths": json.dumps(client._products),
                "backgroundType": "prompt",
                "backgroundPrompt": "neutral studio",
                "direction": "밝은 분위기",
                "shot": "bust",
                "angle": "eye",
            },
        )
    assert r.status_code == 200
    assert fake.await_args.kwargs["rembg_products"] is True


def test_rembg_toggle_off_preserves_background(client):
    """?rembg=false → generator called with rembg_products=False."""
    fake = AsyncMock(return_value=_fake_result())
    with patch("modules.composite_generator.generate_composite_candidates", new=fake):
        r = client.post(
            "/api/composite/generate?rembg=false",
            data={
                "hostImagePath": client._host,
                "productImagePaths": json.dumps(client._products),
                "backgroundType": "prompt",
                "backgroundPrompt": "neutral studio",
                "direction": "밝은 분위기",
                "shot": "bust",
                "angle": "eye",
            },
        )
    assert r.status_code == 200
    assert fake.await_args.kwargs["rembg_products"] is False


def test_korean_direction_preserved_verbatim(client):
    """Korean direction from request reaches generator unchanged (translation is the generator's job)."""
    fake = AsyncMock(return_value=_fake_result())
    korean = "30대 여성 쇼호스트가 화장품을 추천하는 환한 스튜디오"
    with patch("modules.composite_generator.generate_composite_candidates", new=fake):
        r = client.post(
            "/api/composite/generate",
            data={
                "hostImagePath": client._host,
                "productImagePaths": json.dumps(client._products),
                "backgroundType": "prompt",
                "backgroundPrompt": "studio",
                "direction": korean,
                "shot": "bust",
                "angle": "eye",
            },
        )
    assert r.status_code == 200
    assert fake.await_args.kwargs["direction_ko"] == korean


def test_invalid_shot_enum_returns_400(client):
    """shot='weird' → 400 from ValueError in generator enum validator."""
    r = client.post(
        "/api/composite/generate",
        data={
            "hostImagePath": client._host,
            "productImagePaths": json.dumps(client._products),
            "backgroundType": "prompt",
            "backgroundPrompt": "studio",
            "direction": "자연스러운 분위기",
            "shot": "weird",
            "angle": "eye",
        },
    )
    assert r.status_code == 400


def test_invalid_angle_enum_returns_400(client):
    r = client.post(
        "/api/composite/generate",
        data={
            "hostImagePath": client._host,
            "productImagePaths": json.dumps(client._products),
            "backgroundType": "prompt",
            "backgroundPrompt": "studio",
            "direction": "자연스러운 분위기",
            "shot": "bust",
            "angle": "weird",
        },
    )
    assert r.status_code == 400


def test_invalid_background_type_returns_400(client):
    r = client.post(
        "/api/composite/generate",
        data={
            "hostImagePath": client._host,
            "productImagePaths": json.dumps(client._products),
            "backgroundType": "hologram",
            "direction": "자연스러운 분위기",
            "shot": "bust",
            "angle": "eye",
        },
    )
    assert r.status_code == 400


def test_host_path_traversal_rejected(client):
    r = client.post(
        "/api/composite/generate",
        data={
            "hostImagePath": "/etc/passwd",
            "productImagePaths": json.dumps(client._products),
            "backgroundType": "prompt",
            "backgroundPrompt": "studio",
            "direction": "자연스러운 분위기",
            "shot": "bust",
            "angle": "eye",
        },
    )
    assert r.status_code == 400


def test_product_path_traversal_rejected(client):
    r = client.post(
        "/api/composite/generate",
        data={
            "hostImagePath": client._host,
            "productImagePaths": json.dumps(["/etc/shadow"]),
            "backgroundType": "prompt",
            "backgroundPrompt": "studio",
            "direction": "자연스러운 분위기",
            "shot": "bust",
            "angle": "eye",
        },
    )
    assert r.status_code == 400


def test_invalid_product_paths_json_returns_400(client):
    r = client.post(
        "/api/composite/generate",
        data={
            "hostImagePath": client._host,
            "productImagePaths": "not-json",
            "backgroundType": "prompt",
            "backgroundPrompt": "studio",
            "direction": "자연스러운 분위기",
            "shot": "bust",
            "angle": "eye",
        },
    )
    assert r.status_code == 400


def test_all_generation_fails_returns_503(client):
    async def boom(*args, **kwargs):
        raise RuntimeError("Only 0/4 composite candidates succeeded")

    with patch(
        "modules.composite_generator.generate_composite_candidates",
        new=AsyncMock(side_effect=boom),
    ):
        r = client.post(
            "/api/composite/generate",
            data={
                "hostImagePath": client._host,
                "productImagePaths": json.dumps(client._products),
                "backgroundType": "prompt",
                "backgroundPrompt": "studio",
                "direction": "자연스러운 분위기",
                "shot": "bust",
                "angle": "eye",
            },
        )
    assert r.status_code == 503
