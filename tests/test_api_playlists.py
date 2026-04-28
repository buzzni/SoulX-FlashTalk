"""Lane B — /api/playlists CRUD + history filter + generate-with-playlist tests.

Covers the 6 endpoints from docs/playlist-feature-plan.md §4 plus the
playlist_id Form param wired into /api/generate. Repo-level cross-user
isolation lives in test_studio_playlist_repo.py — these tests cover the
request→response shape and the few API-level edges (404/409, history
filter recovery on stale id per decision #12).
"""
from __future__ import annotations

import pytest


@pytest.fixture
def client(monkeypatch, tmp_path):
    """Isolated TestClient with config redirected to tmp_path."""
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    examples = tmp_path / "examples"
    for d in (uploads, outputs, examples):
        d.mkdir(parents=True, exist_ok=True)

    import config

    monkeypatch.setattr(config, "UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "EXAMPLES_DIR", str(examples))
    monkeypatch.setattr(config, "SAFE_ROOTS", (str(uploads), str(outputs), str(examples)))

    from fastapi.testclient import TestClient
    import app as app_module

    with TestClient(app_module.app) as tc:
        yield tc


@pytest.fixture
def as_user(monkeypatch):
    """Returns a callable that swaps the bypass-auth middleware to a different
    user_id mid-test. Useful for cross-user 404 checks.

    Works because app.py's @app.middleware wrapper looks up
    `auth_module.auth_middleware` per-request, so re-monkeypatching mid-test
    takes effect on the next request.
    """
    def _swap(user_id: str):
        async def _bypass(req, call_next):
            req.state.user = {
                "user_id": user_id,
                "display_name": user_id,
                "role": "member",
                "is_active": True,
                "approval_status": "approved",
                "subscriptions": ["platform", "studio"],
                "studio_token_version": 0,
                "hashed_password": "",
            }
            return await call_next(req)
        monkeypatch.setattr("modules.auth.auth_middleware", _bypass)
    return _swap


# ── GET /api/playlists ─────────────────────────────────────────────


def test_list_playlists_empty(client):
    r = client.get("/api/playlists")
    assert r.status_code == 200
    assert r.json() == {"playlists": [], "unassigned_count": 0}


def test_list_playlists_returns_created(client):
    client.post("/api/playlists", data={"name": "겨울 컬렉션"})
    client.post("/api/playlists", data={"name": "신상품"})
    r = client.get("/api/playlists")
    assert r.status_code == 200
    body = r.json()
    names = sorted(p["name"] for p in body["playlists"])
    assert names == ["겨울 컬렉션", "신상품"]
    assert all(p["video_count"] == 0 for p in body["playlists"])
    assert body["unassigned_count"] == 0


# ── POST /api/playlists ────────────────────────────────────────────


def test_create_playlist_returns_id_and_name(client):
    r = client.post("/api/playlists", data={"name": "Winter"})
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Winter"
    assert len(body["playlist_id"]) == 32
    assert body["video_count"] == 0


def test_create_playlist_duplicate_returns_409(client):
    client.post("/api/playlists", data={"name": "x"})
    r = client.post("/api/playlists", data={"name": "x"})
    assert r.status_code == 409


def test_create_playlist_casefold_collision_returns_409(client):
    client.post("/api/playlists", data={"name": "Winter"})
    r = client.post("/api/playlists", data={"name": "WINTER"})
    assert r.status_code == 409


def test_create_playlist_reserved_name_returns_400(client):
    r = client.post("/api/playlists", data={"name": "미지정"})
    assert r.status_code == 400


def test_create_playlist_empty_name_returns_400(client):
    r = client.post("/api/playlists", data={"name": "   "})
    assert r.status_code == 400


# ── PATCH /api/playlists/{id} ─────────────────────────────────────


def test_rename_playlist_happy(client):
    pid = client.post("/api/playlists", data={"name": "old"}).json()["playlist_id"]
    r = client.patch(f"/api/playlists/{pid}", data={"name": "new"})
    assert r.status_code == 200
    assert r.json()["name"] == "new"


def test_rename_playlist_dup_returns_409(client):
    a = client.post("/api/playlists", data={"name": "A"}).json()["playlist_id"]
    client.post("/api/playlists", data={"name": "B"})
    r = client.patch(f"/api/playlists/{a}", data={"name": "B"})
    assert r.status_code == 409


def test_rename_playlist_reserved_returns_400(client):
    pid = client.post("/api/playlists", data={"name": "x"}).json()["playlist_id"]
    r = client.patch(f"/api/playlists/{pid}", data={"name": "미지정"})
    assert r.status_code == 400


def test_rename_playlist_missing_returns_404(client):
    r = client.patch(f"/api/playlists/{'a' * 32}", data={"name": "x"})
    assert r.status_code == 404


def test_rename_playlist_invalid_id_returns_400(client):
    r = client.patch("/api/playlists/not-hex", data={"name": "x"})
    assert r.status_code == 400


def test_rename_playlist_cross_user_returns_404(client, as_user):
    pid = client.post("/api/playlists", data={"name": "private"}).json()["playlist_id"]
    as_user("intruder")
    r = client.patch(f"/api/playlists/{pid}", data={"name": "stolen"})
    assert r.status_code == 404


# ── DELETE /api/playlists/{id} ────────────────────────────────────


def test_delete_playlist_happy(client):
    pid = client.post("/api/playlists", data={"name": "x"}).json()["playlist_id"]
    r = client.delete(f"/api/playlists/{pid}")
    assert r.status_code == 200
    assert r.json()["playlist_id"] == pid
    # Subsequent get returns empty list
    assert client.get("/api/playlists").json()["playlists"] == []


def test_delete_playlist_missing_returns_404(client):
    r = client.delete(f"/api/playlists/{'a' * 32}")
    assert r.status_code == 404


def test_delete_playlist_invalid_id_returns_400(client):
    r = client.delete("/api/playlists/short")
    assert r.status_code == 400


def test_delete_playlist_cross_user_returns_404(client, as_user):
    pid = client.post("/api/playlists", data={"name": "private"}).json()["playlist_id"]
    as_user("intruder")
    r = client.delete(f"/api/playlists/{pid}")
    assert r.status_code == 404


# ── PATCH /api/results/{task_id}/playlist ─────────────────────────


def _seed_result(client, *, task_id: str = "task1234567890abcdef" + "0" * 12,
                  playlist_id: str | None = None) -> str:
    """Insert a fake studio_results row directly via sync pymongo so PATCH
    has a target. Async repo + TestClient run on different loops, which is
    why we can't reuse studio_result_repo.upsert for seeding."""
    return _seed_result_for_user(client, "testuser", task_id=task_id,
                                  playlist_id=playlist_id)


def test_move_result_to_playlist_happy(client):
    pid = client.post("/api/playlists", data={"name": "x"}).json()["playlist_id"]
    task_id = _seed_result(client)
    r = client.patch(f"/api/results/{task_id}/playlist", data={"playlist_id": pid})
    assert r.status_code == 200
    assert r.json()["playlist_id"] == pid


def test_move_result_to_unassigned_via_empty_string(client):
    pid = client.post("/api/playlists", data={"name": "x"}).json()["playlist_id"]
    task_id = _seed_result(client, playlist_id=pid)
    r = client.patch(f"/api/results/{task_id}/playlist", data={"playlist_id": ""})
    assert r.status_code == 200
    assert r.json()["playlist_id"] is None


def test_move_result_unknown_playlist_returns_404(client):
    task_id = _seed_result(client)
    r = client.patch(
        f"/api/results/{task_id}/playlist",
        data={"playlist_id": "f" * 32},
    )
    assert r.status_code == 404


def test_move_result_missing_result_returns_404(client):
    pid = client.post("/api/playlists", data={"name": "x"}).json()["playlist_id"]
    r = client.patch(
        f"/api/results/{'b' * 32}/playlist",
        data={"playlist_id": pid},
    )
    assert r.status_code == 404


def test_move_result_invalid_playlist_id_returns_400(client):
    task_id = _seed_result(client)
    r = client.patch(
        f"/api/results/{task_id}/playlist",
        data={"playlist_id": "not-hex"},
    )
    assert r.status_code == 400


def test_move_result_cross_user_playlist_returns_404(client, as_user):
    # alice creates a playlist; bob tries to move his own result into it
    pid = client.post("/api/playlists", data={"name": "alice-private"}).json()["playlist_id"]
    as_user("bob")
    bob_task = _seed_result_for_user(client, "bob", task_id="bobtask" + "0" * 25)
    r = client.patch(
        f"/api/results/{bob_task}/playlist",
        data={"playlist_id": pid},
    )
    assert r.status_code == 404


def _seed_result_for_user(client, user_id: str, *, task_id: str,
                            playlist_id: str | None = None) -> str:
    """Insert a fake studio_results row via sync pymongo (avoids the
    motor-on-wrong-loop trap when seeding inside a TestClient session).

    Sets completed_at so /api/history's HistoryResponse validates (the
    response_model requires `timestamp` to be a string)."""
    from datetime import datetime, timezone
    from pymongo import MongoClient
    import config
    mc = MongoClient(config.MONGO_URL, serverSelectionTimeoutMS=2000)
    mc[config.DB_NAME].studio_results.update_one(
        {"user_id": user_id, "task_id": task_id},
        {"$set": {
            "user_id": user_id,
            "task_id": task_id,
            "type": "generate",
            "status": "completed",
            "playlist_id": playlist_id,
            "completed_at": datetime.now(timezone.utc),
            "video_storage_key": "outputs/test.mp4",
            "video_bytes": 1,
            "params": {"script_text": "", "host_image": ""},
        }},
        upsert=True,
    )
    mc.close()
    return task_id


# ── GET /api/history?playlist_id=... ──────────────────────────────


def test_history_filters_by_playlist_id(client):
    pid_a = client.post("/api/playlists", data={"name": "A"}).json()["playlist_id"]
    pid_b = client.post("/api/playlists", data={"name": "B"}).json()["playlist_id"]
    _seed_result_for_user(client, "testuser", task_id="aaa" + "0" * 29)
    _seed_result_for_user(client, "testuser", task_id="bbb" + "0" * 29)
    # Move them into different playlists
    client.patch("/api/results/aaa" + "0" * 29 + "/playlist", data={"playlist_id": pid_a})
    client.patch("/api/results/bbb" + "0" * 29 + "/playlist", data={"playlist_id": pid_b})
    # Filter to A
    r = client.get(f"/api/history?playlist_id={pid_a}")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["videos"][0]["task_id"] == "aaa" + "0" * 29


def test_history_filter_unassigned(client):
    pid = client.post("/api/playlists", data={"name": "A"}).json()["playlist_id"]
    _seed_result_for_user(client, "testuser", task_id="aaa" + "0" * 29)
    _seed_result_for_user(client, "testuser", task_id="bbb" + "0" * 29)
    client.patch("/api/results/aaa" + "0" * 29 + "/playlist", data={"playlist_id": pid})
    # bbb stays unassigned
    r = client.get("/api/history?playlist_id=unassigned")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["videos"][0]["task_id"] == "bbb" + "0" * 29


def test_history_filter_unknown_id_returns_empty(client):
    """Plan decision #12: stale id from another tab should not break filter UI."""
    _seed_result_for_user(client, "testuser", task_id="aaa" + "0" * 29)
    r = client.get(f"/api/history?playlist_id={'f' * 32}")
    assert r.status_code == 200
    assert r.json() == {"total": 0, "videos": []}


# ── /api/history status filter (decision #5/#20) ──────────────────


def _seed_failed_for_user(client, user_id: str, *, task_id: str):
    """Insert a fake failed studio_results row with public_error mapped."""
    from datetime import datetime, timezone
    from pymongo import MongoClient
    import config
    mc = MongoClient(config.MONGO_URL, serverSelectionTimeoutMS=2000)
    mc[config.DB_NAME].studio_results.update_one(
        {"user_id": user_id, "task_id": task_id},
        {"$set": {
            "user_id": user_id, "task_id": task_id,
            "type": "generate", "status": "error",
            "error": "audio file not found",
            "public_error": "음성 파일을 찾을 수 없어요. 파일이 삭제됐을 수 있어요.",
            "completed_at": datetime.now(timezone.utc),
            "video_path": None, "video_bytes": 0,
            "params": {"prompt": "p", "seed": 1},
        }}, upsert=True,
    )
    mc.close()
    return task_id


def _seed_cancelled_for_user(client, user_id: str, *, task_id: str):
    from datetime import datetime, timezone
    from pymongo import MongoClient
    import config
    mc = MongoClient(config.MONGO_URL, serverSelectionTimeoutMS=2000)
    mc[config.DB_NAME].studio_results.update_one(
        {"user_id": user_id, "task_id": task_id},
        {"$set": {
            "user_id": user_id, "task_id": task_id,
            "type": "generate", "status": "cancelled",
            "error": None, "public_error": "사용자가 취소했어요.",
            "completed_at": datetime.now(timezone.utc),
            "video_path": None, "video_bytes": 0,
            "params": {},
        }}, upsert=True,
    )
    mc.close()
    return task_id


def test_history_status_all_includes_terminal_states(client):
    """Decision #5: 'all' default returns completed + error + cancelled."""
    _seed_result_for_user(client, "testuser", task_id="ok" + "0" * 30)
    _seed_failed_for_user(client, "testuser", task_id="fail" + "0" * 28)
    _seed_cancelled_for_user(client, "testuser", task_id="cncl" + "0" * 28)
    r = client.get("/api/history")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 3
    statuses = sorted(v["status"] for v in body["videos"])
    assert statuses == ["cancelled", "completed", "error"]


def test_history_status_filter_completed(client):
    _seed_result_for_user(client, "testuser", task_id="ok" + "0" * 30)
    _seed_failed_for_user(client, "testuser", task_id="fail" + "0" * 28)
    r = client.get("/api/history?status=completed")
    assert r.status_code == 200
    assert r.json()["total"] == 1
    assert r.json()["videos"][0]["status"] == "completed"


def test_history_status_filter_error_returns_public_error(client):
    """Decision #22: response includes public_error, not raw error."""
    _seed_failed_for_user(client, "testuser", task_id="fail" + "0" * 28)
    r = client.get("/api/history?status=error")
    body = r.json()
    assert body["total"] == 1
    v = body["videos"][0]
    assert v["status"] == "error"
    assert v["public_error"] == "음성 파일을 찾을 수 없어요. 파일이 삭제됐을 수 있어요."
    # Raw `error` from the worker MUST NOT be in the projected response.
    assert "error" not in v or v.get("error") is None


def test_history_status_invalid_value_400(client):
    r = client.get("/api/history?status=bogus")
    assert r.status_code == 400


def test_history_pagination_offset_limit(client):
    for i in range(5):
        _seed_result_for_user(client, "testuser", task_id=f"t{i:031d}")
    r = client.get("/api/history?offset=0&limit=2")
    body = r.json()
    assert body["total"] == 5
    assert len(body["videos"]) == 2
    r = client.get("/api/history?offset=4&limit=2")
    assert len(r.json()["videos"]) == 1


def test_history_beyond_last_page_returns_empty_with_total(client):
    """Plan §10 failure mode: stale page after deletion."""
    _seed_result_for_user(client, "testuser", task_id="t" + "0" * 31)
    r = client.get("/api/history?offset=999&limit=24")
    body = r.json()
    assert body["total"] == 1
    assert body["videos"] == []


# ── /api/history/counts (decision #14) ────────────────────────────


def test_history_counts_sum_invariant(client):
    """all == completed + error + cancelled."""
    _seed_result_for_user(client, "testuser", task_id="c1" + "0" * 30)
    _seed_result_for_user(client, "testuser", task_id="c2" + "0" * 30)
    _seed_failed_for_user(client, "testuser", task_id="e1" + "0" * 30)
    _seed_cancelled_for_user(client, "testuser", task_id="x1" + "0" * 30)
    r = client.get("/api/history/counts")
    assert r.status_code == 200
    counts = r.json()
    assert counts == {"all": 4, "completed": 2, "error": 1, "cancelled": 1}
    assert counts["all"] == counts["completed"] + counts["error"] + counts["cancelled"]


def test_history_counts_empty(client):
    r = client.get("/api/history/counts")
    assert r.status_code == 200
    assert r.json() == {"all": 0, "completed": 0, "error": 0, "cancelled": 0}


def test_history_counts_scoped_by_playlist(client):
    pid = client.post("/api/playlists", data={"name": "A"}).json()["playlist_id"]
    t1 = _seed_result_for_user(client, "testuser", task_id="aaa" + "0" * 29)
    _seed_result_for_user(client, "testuser", task_id="bbb" + "0" * 29)
    client.patch(f"/api/results/{t1}/playlist", data={"playlist_id": pid})
    r = client.get(f"/api/history/counts?playlist_id={pid}")
    assert r.json()["all"] == 1
    assert r.json()["completed"] == 1


def test_history_counts_unassigned(client):
    pid = client.post("/api/playlists", data={"name": "A"}).json()["playlist_id"]
    t1 = _seed_result_for_user(client, "testuser", task_id="aaa" + "0" * 29)
    _seed_result_for_user(client, "testuser", task_id="bbb" + "0" * 29)  # unassigned
    client.patch(f"/api/results/{t1}/playlist", data={"playlist_id": pid})
    r = client.get("/api/history/counts?playlist_id=unassigned")
    assert r.json()["completed"] == 1


# ── playlist count semantics regression (decision #21) ────────────


def test_playlist_count_includes_failed_and_cancelled(client):
    """Decision #21: playlist video_count covers all terminal rows so it
    aligns with status filter chip totals when the user scopes to a playlist."""
    pid = client.post("/api/playlists", data={"name": "A"}).json()["playlist_id"]
    t_ok = _seed_result_for_user(client, "testuser", task_id="ok" + "0" * 30)
    t_fail = _seed_failed_for_user(client, "testuser", task_id="fl" + "0" * 30)
    t_cncl = _seed_cancelled_for_user(client, "testuser", task_id="cn" + "0" * 30)
    for t in [t_ok, t_fail, t_cncl]:
        client.patch(f"/api/results/{t}/playlist", data={"playlist_id": pid})
    r = client.get("/api/playlists")
    body = r.json()
    by_id = {p["playlist_id"]: p for p in body["playlists"]}
    assert by_id[pid]["video_count"] == 3


# ── /api/generate accepts playlist_id Form param ──────────────────


def test_generate_accepts_playlist_id_form_param(client, monkeypatch):
    """Verify playlist_id flows through to the queue params dict.
    We don't actually run inference — we capture the enqueue() call."""
    import app as app_module

    captured = {}

    async def _fake_enqueue(*, task_id, task_type, params, user_id, label):
        captured["params"] = params
        captured["user_id"] = user_id

    monkeypatch.setattr(app_module.task_queue, "enqueue", _fake_enqueue)

    pid = client.post("/api/playlists", data={"name": "Winter"}).json()["playlist_id"]

    # /api/generate accepts host_image_path optional; with no image set,
    # it falls back to config.DEFAULT_HOST_IMAGE. If that file doesn't exist
    # the endpoint 404s before enqueue. We monkeypatch DEFAULT_HOST_IMAGE
    # and DEFAULT_AUDIO to the test outputs dir.
    import config
    import os
    host = os.path.join(config.OUTPUTS_DIR, "host.png")
    audio = os.path.join(config.OUTPUTS_DIR, "audio.wav")
    open(host, "wb").write(b"png-bytes")
    open(audio, "wb").write(b"wav-bytes")
    monkeypatch.setattr(config, "DEFAULT_HOST_IMAGE", host)
    monkeypatch.setattr(config, "DEFAULT_AUDIO", audio)

    r = client.post(
        "/api/generate",
        data={
            "audio_source": "upload",
            "playlist_id": pid,
        },
    )
    assert r.status_code == 200, r.text
    assert captured["params"]["playlist_id"] == pid


def test_generate_empty_playlist_id_normalizes_to_none(client, monkeypatch):
    import app as app_module
    captured = {}

    async def _fake_enqueue(*, task_id, task_type, params, user_id, label):
        captured["params"] = params

    monkeypatch.setattr(app_module.task_queue, "enqueue", _fake_enqueue)

    import config
    import os
    host = os.path.join(config.OUTPUTS_DIR, "host.png")
    audio = os.path.join(config.OUTPUTS_DIR, "audio.wav")
    open(host, "wb").write(b"png-bytes")
    open(audio, "wb").write(b"wav-bytes")
    monkeypatch.setattr(config, "DEFAULT_HOST_IMAGE", host)
    monkeypatch.setattr(config, "DEFAULT_AUDIO", audio)

    r = client.post(
        "/api/generate",
        data={"audio_source": "upload", "playlist_id": ""},
    )
    assert r.status_code == 200, r.text
    assert captured["params"]["playlist_id"] is None
