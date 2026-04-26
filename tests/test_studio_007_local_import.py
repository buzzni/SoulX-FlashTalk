"""Tests for scripts.studio_007_local_import (PR4 hosts portion)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from time import sleep

import pytest
from pymongo import MongoClient


REPO_ROOT = Path(__file__).resolve().parent.parent


def _test_db_name() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER", "main")
    return f"ai_showhost_test_{worker}_007"


@pytest.fixture
def fresh_setup(tmp_path):
    """Per-test bucket dirs, per-worker test DB, clean collections."""
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    examples = tmp_path / "examples"
    hosts_dir = outputs / "hosts" / "saved"
    comp_dir = outputs / "composites"
    for d in (uploads, outputs, examples, hosts_dir, comp_dir):
        d.mkdir(parents=True, exist_ok=True)

    client = MongoClient("mongodb://localhost:27017", serverSelectionTimeoutMS=2000)
    db = client[_test_db_name()]
    for coll in db.list_collection_names():
        db[coll].drop()
    yield uploads, outputs, hosts_dir, comp_dir, db
    for coll in db.list_collection_names():
        db[coll].drop()
    client.close()


def _write_pair(image_path: Path, meta: dict) -> None:
    image_path.write_bytes(b"png-bytes")
    (Path(str(image_path) + ".meta.json")).write_text(
        json.dumps(meta, ensure_ascii=False), encoding="utf-8")


def _run(args: list[str], outputs: Path, uploads: Path, examples: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "studio_007_local_import.py"), *args],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
        env={
            **os.environ,
            "DB_NAME": _test_db_name(),
            "MONGO_URL": "mongodb://localhost:27017",
            # Override config bucket dirs via env so the script's _bucket_dirs
            # picks up tmp_path. config.py reads these from os.environ when
            # present (we'll inject via PYTHON path manipulation below).
        },
    )


@pytest.fixture
def patched_config(monkeypatch, tmp_path):
    """Force config.* dirs to point at tmp_path for this process and the
    subprocess we'll spawn (the subprocess re-imports config but we hand
    it the same paths via env-controlled config attributes)."""
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    examples = tmp_path / "examples"
    monkeypatch.setenv("STUDIO_TEST_UPLOADS_DIR", str(uploads))
    monkeypatch.setenv("STUDIO_TEST_OUTPUTS_DIR", str(outputs))
    monkeypatch.setenv("STUDIO_TEST_EXAMPLES_DIR", str(examples))


def _run_inline(args: list[str], cwd: Path) -> tuple[int, str, str]:
    """Run the script in-process so monkeypatched config.* dirs apply."""
    import importlib
    sys.path.insert(0, str(REPO_ROOT))

    # Force a fresh module import so it picks up patched config attributes.
    for mod_name in list(sys.modules):
        if mod_name == "scripts.studio_007_local_import":
            del sys.modules[mod_name]
    mod = importlib.import_module("scripts.studio_007_local_import")

    saved_argv = sys.argv
    sys.argv = ["studio_007_local_import.py", *args]
    import io, contextlib
    err = io.StringIO()
    out = io.StringIO()
    rc = 0
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                rc = mod.main()
            except SystemExit as e:
                rc = e.code or 0
            except RuntimeError as e:
                # assert_local_only refusals surface here; report as nonzero rc.
                err.write(str(e))
                rc = 2
    finally:
        sys.argv = saved_argv
    return rc, out.getvalue(), err.getvalue()


def test_dry_run_no_writes(fresh_setup, monkeypatch):
    uploads, outputs, hosts_dir, _, db = fresh_setup
    import config
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(uploads.parent / "examples"))

    _write_pair(hosts_dir / "host_a_s1.png", {"image_id": "host_a_s1", "status": "draft"})

    monkeypatch.setenv("DB_NAME", _test_db_name())
    rc, _, _ = _run_inline(["--owner", "u1", "--dry-run"], REPO_ROOT)
    assert rc == 0
    assert db.studio_hosts.count_documents({}) == 0


def test_commit_imports_candidate_hosts(fresh_setup, monkeypatch):
    uploads, outputs, hosts_dir, comp_dir, db = fresh_setup
    import config
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(uploads.parent / "examples"))

    _write_pair(hosts_dir / "host_a_s1.png",
                {"image_id": "host_a_s1", "status": "committed",
                 "video_ids": ["v1"], "seed": 42})
    _write_pair(comp_dir / "composite_x_s1.png",
                {"image_id": "composite_x_s1", "status": "draft",
                 "batch_id": "b1", "seed": 7})

    monkeypatch.setenv("DB_NAME", _test_db_name())
    rc, out, err = _run_inline(["--owner", "jack", "--commit"], REPO_ROOT)
    assert rc == 0, out + err
    rows = list(db.studio_hosts.find({}))
    assert len(rows) == 2
    by_step = {r["step"]: r for r in rows}
    assert by_step["1-host"]["image_id"] == "host_a_s1"
    assert by_step["1-host"]["status"] == "committed"
    assert by_step["1-host"]["video_ids"] == ["v1"]
    assert by_step["1-host"]["storage_key"].startswith("outputs/hosts/saved/host_a_s1.png")
    assert by_step["2-composite"]["image_id"] == "composite_x_s1"
    assert by_step["2-composite"]["batch_id"] == "b1"


def test_demotes_duplicate_selected(fresh_setup, monkeypatch):
    """Codex N4: two host metas claim 'selected' for the same step;
    one must be demoted to 'draft' before insert so the partial-unique
    index doesn't reject the second writer."""
    uploads, outputs, hosts_dir, _, db = fresh_setup
    import config
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(uploads.parent / "examples"))

    _write_pair(hosts_dir / "host_a_s1.png",
                {"image_id": "host_a_s1", "status": "selected",
                 "generated_iso": "2026-04-20T01:00:00+0900"})
    _write_pair(hosts_dir / "host_b_s1.png",
                {"image_id": "host_b_s1", "status": "selected",
                 "generated_iso": "2026-04-25T03:00:00+0900"})  # most recent

    monkeypatch.setenv("DB_NAME", _test_db_name())
    rc, out, err = _run_inline(["--owner", "jack", "--commit"], REPO_ROOT)
    assert rc == 0, out + err
    rows = list(db.studio_hosts.find({}, {"image_id": 1, "status": 1, "_id": 0}))
    by_id = {r["image_id"]: r["status"] for r in rows}
    assert by_id["host_b_s1"] == "selected"  # newest stays selected
    assert by_id["host_a_s1"] == "draft"     # older demoted


def test_rerun_is_idempotent_per_record(fresh_setup, monkeypatch):
    uploads, outputs, hosts_dir, _, db = fresh_setup
    import config
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(uploads.parent / "examples"))

    _write_pair(hosts_dir / "host_a_s1.png",
                {"image_id": "host_a_s1", "status": "committed", "video_ids": ["v1"]})

    monkeypatch.setenv("DB_NAME", _test_db_name())
    _run_inline(["--owner", "jack", "--commit"], REPO_ROOT)
    _run_inline(["--owner", "jack", "--commit"], REPO_ROOT)
    assert db.studio_hosts.count_documents({}) == 1
    # studio_migrations row appended both times
    assert db.studio_migrations.count_documents(
        {"name": "studio_007_local_import"}) == 2


def test_imports_saved_hosts_from_uuid_sidecars(fresh_setup, monkeypatch):
    uploads, outputs, hosts_dir, _, db = fresh_setup
    import config
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(uploads.parent / "examples"))

    # uuid32 png + sidecar (NOT host_*.png — that's a candidate)
    uuid32 = "deadbeef" * 4
    img = hosts_dir / f"{uuid32}.png"
    img.write_bytes(b"png")
    sidecar = hosts_dir / f"{uuid32}.json"
    sidecar.write_text(json.dumps({
        "id": uuid32, "name": "library host", "path": str(img),
        "url": f"/api/files/outputs/hosts/saved/{uuid32}.png",
    }), encoding="utf-8")

    monkeypatch.setenv("DB_NAME", _test_db_name())
    rc, out, err = _run_inline(["--owner", "jack", "--commit"], REPO_ROOT)
    assert rc == 0, out + err
    rows = list(db.studio_saved_hosts.find({}))
    assert len(rows) == 1
    assert rows[0]["host_id"] == uuid32
    assert rows[0]["name"] == "library host"
    assert rows[0]["storage_key"] == f"outputs/hosts/saved/{uuid32}.png"


def test_imports_result_manifests(fresh_setup, monkeypatch):
    """PR5: outputs/results/*.json → studio_results."""
    uploads, outputs, _, _, db = fresh_setup
    import config
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(uploads.parent / "examples"))

    rdir = outputs / "results"
    rdir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "task_id": "abc123",
        "type": "generate",
        "status": "completed",
        "completed_at": "2026-04-25T12:00:00",
        "generation_time_sec": 60.5,
        "video_url": "/api/videos/abc123",
        "video_path": str(outputs / "res_abc123.mp4"),
        "video_bytes": 1234,
        "video_filename": "res_abc123.mp4",
        "params": {
            "host_image": str(outputs / "hosts" / "saved" / "host_x.png"),  # absolute
            "audio_path": str(uploads / "audio.wav"),                       # absolute
            "prompt": "p",
            "seed": 42,
            "reference_image_paths": [str(uploads / "ref.png")],
        },
        "meta": {
            "host": {
                "selectedPath": str(outputs / "hosts" / "saved" / "host_x.png"),
                "imageUrl": "/api/files/outputs/hosts/saved/host_x.png",
            },
        },
    }
    (rdir / "abc123.json").write_text(json.dumps(manifest), encoding="utf-8")

    monkeypatch.setenv("DB_NAME", _test_db_name())
    rc, out, err = _run_inline(["--owner", "jack", "--commit"], REPO_ROOT)
    assert rc == 0, out + err

    rows = list(db.studio_results.find({}))
    assert len(rows) == 1
    r = rows[0]
    assert r["task_id"] == "abc123"
    assert r["user_id"] == "jack"
    # Absolute paths in params should be scrubbed to bucket-prefixed keys.
    assert r["params"]["host_image"] == "outputs/hosts/saved/host_x.png"
    assert r["params"]["audio_path"] == "uploads/audio.wav"
    assert r["params"]["reference_image_paths"] == ["uploads/ref.png"]
    assert r["meta"]["host"]["selectedPath"] == "outputs/hosts/saved/host_x.png"
    # imageUrl is not a filesystem path → unchanged.
    assert r["meta"]["host"]["imageUrl"] == "/api/files/outputs/hosts/saved/host_x.png"
    # video_storage_key derived from the scrubbed video_path.
    assert r["video_storage_key"] == "outputs/res_abc123.mp4"


def test_assert_local_only_blocks_prod_url(fresh_setup, monkeypatch):
    monkeypatch.setenv("DB_NAME", _test_db_name())
    monkeypatch.setenv("MONGO_URL", "mongodb://prod.example.com:27017/")
    rc, out, err = _run_inline(["--owner", "jack", "--commit"], REPO_ROOT)
    assert rc != 0 or "refused" in (out + err)
