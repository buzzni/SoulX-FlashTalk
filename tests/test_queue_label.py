"""Unit tests for app._build_queue_label.

Regression coverage for the "queue only shows 'video generation'" bug —
the frontend wasn't sending script_text on /api/generate, so every job
landed with the generic fallback label.
"""
from __future__ import annotations


def test_explicit_label_wins():
    from app import _build_queue_label
    assert _build_queue_label("My job", "ignored", "1280x720", "/x/host.png") == "My job"


def test_falls_back_to_script_preview_with_whitespace_collapsed():
    from app import _build_queue_label
    label = _build_queue_label(None, "  안녕하세요\n\n   소파에  앉아  ", "720x1280", None)
    assert label == "안녕하세요 소파에 앉아"


def test_truncates_long_script_to_80_chars():
    from app import _build_queue_label
    long_script = "가" * 200
    label = _build_queue_label(None, long_script, None, None)
    assert len(label) == 80


def test_resolution_and_host_filename_when_no_script():
    from app import _build_queue_label
    label = _build_queue_label(None, "", "720x1280", "/some/path/host_abc.png")
    # 720×1280 (note × not x) · host_abc.png
    assert "720×1280" in label
    assert "host_abc.png" in label


def test_generic_fallback_when_nothing_provided():
    from app import _build_queue_label
    assert _build_queue_label(None, None, None, None) == "쇼호스트 영상"
    assert _build_queue_label("", "", "", "") == "쇼호스트 영상"


def test_explicit_whitespace_only_falls_through():
    from app import _build_queue_label
    label = _build_queue_label("   ", "real script text", None, None)
    assert label == "real script text"
