"""Phase 4 — voice.pitch ffmpeg rubberband post-processing (D2)."""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.phase4


@pytest.mark.skip(reason="TDD placeholder — zero pitch skips ffmpeg")
def test_zero_pitch_skips_ffmpeg_invocation():
    """pitch=0 → no ffmpeg call (performance)."""
    ...


@pytest.mark.skip(reason="TDD placeholder — positive pitch applies rubberband")
def test_positive_pitch_invokes_rubberband_filter():
    """pitch=+3 → ffmpeg -af 'rubberband=pitch=...' with 2^(3/12) ratio."""
    ...


@pytest.mark.skip(reason="TDD placeholder — pitch applied AFTER FlashTalk render")
def test_pitch_applied_after_flashtalk_not_before():
    """Lip-sync preserved: pitch shift only on final MP4 audio track."""
    ...


@pytest.mark.skip(reason="TDD placeholder — ffmpeg build has rubberband")
def test_ffmpeg_has_rubberband_filter_available():
    """Preflight check: `ffmpeg -filters` lists rubberband."""
    ...
