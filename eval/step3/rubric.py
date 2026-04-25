"""Rubric score schema + blind-map join (spec v3 §3.3, §3.4).

Binary gate: would_show_to_customer (true/false).
Diagnostic dims: 0-4 each, for root-cause only, not gating.

Operator scores UUID-keyed blind files; this module joins UUIDs back to
(fixture_id, config_id) tuples using _blind_map.json.
"""
from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


class Score(BaseModel):
    model_config = ConfigDict(extra="forbid")
    would_show_to_customer: bool
    mouth_over_articulation: int = Field(ge=0, le=4)
    body_motion_naturalness: int = Field(ge=0, le=4)
    lip_sync_tightness: int = Field(ge=0, le=4)
    identity_preservation: int = Field(ge=0, le=4)
    notes: str = ""


class BlindEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    blind_uuid: str
    fixture_id: str
    config_id: str


class BlindScores(BaseModel):
    """UUID → Score, as written by the operator against blind filenames."""
    model_config = ConfigDict(extra="forbid")
    scores: dict[str, Score]


class JoinedScore(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fixture_id: str
    config_id: str
    score: Score


def load_blind_map(path: str | Path) -> list[BlindEntry]:
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    return [BlindEntry.model_validate(e) for e in raw]


def load_blind_scores(path: str | Path) -> BlindScores:
    with open(path, "r", encoding="utf-8") as f:
        return BlindScores.model_validate(json.load(f))


def write_blind_map(entries: list[BlindEntry], path: str | Path) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump([e.model_dump() for e in entries], f, indent=2)


def join_scores(
    blind_map: list[BlindEntry],
    blind_scores: BlindScores,
) -> list[JoinedScore]:
    """Join operator's UUID-keyed scores back to (fixture, config) tuples.

    Missing scores → dropped (operator can skip a video).
    Scores for unknown UUIDs → ValueError.
    """
    uuid_to_pair = {e.blind_uuid: (e.fixture_id, e.config_id) for e in blind_map}
    joined = []
    for uuid, score in blind_scores.scores.items():
        if uuid not in uuid_to_pair:
            raise ValueError(f"Unknown blind UUID in scores: {uuid}")
        fixture_id, config_id = uuid_to_pair[uuid]
        joined.append(JoinedScore(fixture_id=fixture_id, config_id=config_id, score=score))
    return joined


def yes_rate(joined: list[JoinedScore], config_id: str) -> tuple[int, int]:
    """Return (yes_count, total) for would_show_to_customer of a given config."""
    subset = [j for j in joined if j.config_id == config_id]
    yes = sum(1 for j in subset if j.score.would_show_to_customer)
    return yes, len(subset)
