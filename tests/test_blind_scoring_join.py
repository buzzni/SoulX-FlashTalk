"""Blind UUID → (fixture_id, config_id) join logic in eval/step3/rubric.py."""
from __future__ import annotations

import pytest

from eval.step3.rubric import (
    BlindEntry,
    BlindScores,
    Score,
    join_scores,
    yes_rate,
)


def _score(**overrides) -> Score:
    base = dict(
        would_show_to_customer=True,
        mouth_over_articulation=1,
        body_motion_naturalness=3,
        lip_sync_tightness=3,
        identity_preservation=4,
        notes="",
    )
    base.update(overrides)
    return Score(**base)


def test_join_two_configs_one_fixture():
    blind_map = [
        BlindEntry(blind_uuid="u-a", fixture_id="fix-01", config_id="baseline"),
        BlindEntry(blind_uuid="u-b", fixture_id="fix-01", config_id="s3b-p-v1"),
    ]
    blind_scores = BlindScores(scores={
        "u-a": _score(would_show_to_customer=False),
        "u-b": _score(would_show_to_customer=True),
    })
    joined = join_scores(blind_map, blind_scores)
    by_config = {j.config_id: j.score.would_show_to_customer for j in joined}
    assert by_config == {"baseline": False, "s3b-p-v1": True}


def test_unknown_uuid_raises():
    blind_map = [
        BlindEntry(blind_uuid="u-a", fixture_id="fix-01", config_id="baseline"),
    ]
    blind_scores = BlindScores(scores={"ghost-uuid": _score()})
    with pytest.raises(ValueError, match="Unknown blind UUID"):
        join_scores(blind_map, blind_scores)


def test_partial_scores_silently_skipped():
    """Operator can skip a video; join produces only the scored subset."""
    blind_map = [
        BlindEntry(blind_uuid="u-a", fixture_id="fix-01", config_id="baseline"),
        BlindEntry(blind_uuid="u-b", fixture_id="fix-02", config_id="baseline"),
    ]
    blind_scores = BlindScores(scores={"u-a": _score()})
    joined = join_scores(blind_map, blind_scores)
    assert len(joined) == 1
    assert joined[0].fixture_id == "fix-01"


def test_yes_rate_counts_correctly():
    blind_map = [
        BlindEntry(blind_uuid=f"u-{i}", fixture_id=f"fix-{i}", config_id="s3b-p-v1")
        for i in range(4)
    ]
    blind_scores = BlindScores(scores={
        "u-0": _score(would_show_to_customer=True),
        "u-1": _score(would_show_to_customer=True),
        "u-2": _score(would_show_to_customer=False),
        "u-3": _score(would_show_to_customer=True),
    })
    joined = join_scores(blind_map, blind_scores)
    yes, total = yes_rate(joined, "s3b-p-v1")
    assert (yes, total) == (3, 4)


def test_score_field_bounds_enforced():
    """Diagnostic dims bounded 0..4 per spec §3.3."""
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        _score(mouth_over_articulation=5)
    with pytest.raises(ValidationError):
        _score(identity_preservation=-1)
