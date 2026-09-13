"""Threshold loading and breach detection.

A threshold config is a JSON file mapping metric name → threshold value.
For metrics where higher is better, `score >= threshold` passes. For
metrics where lower is better (false_refusal), `score <= threshold`
passes.

Metrics not mentioned in the config are unconstrained (no gate).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .metrics import HIGHER_IS_BETTER, Aggregate


@dataclass(frozen=True)
class Breach:
    metric: str
    score: float
    threshold: float
    higher_is_better: bool


def load_thresholds(path: Path) -> dict[str, float]:
    if not path.exists():
        raise FileNotFoundError(f"Threshold config not found: {path}")
    with path.open("r", encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        raise ValueError(f"{path}: threshold config must be an object")
    out: dict[str, float] = {}
    for metric, threshold in raw.items():
        if metric not in HIGHER_IS_BETTER:
            raise ValueError(f"{path}: unknown metric '{metric}'")
        if not isinstance(threshold, (int, float)):
            raise ValueError(f"{path}: threshold for '{metric}' must be numeric")
        out[metric] = float(threshold)
    return out


def find_breaches(
    aggregates: dict[str, Aggregate], thresholds: dict[str, float]
) -> list[Breach]:
    breaches: list[Breach] = []
    for metric, threshold in thresholds.items():
        agg = aggregates.get(metric)
        if agg is None:
            continue
        passed = agg.score >= threshold if agg.higher_is_better else agg.score <= threshold
        if not passed:
            breaches.append(
                Breach(
                    metric=metric,
                    score=agg.score,
                    threshold=threshold,
                    higher_is_better=agg.higher_is_better,
                )
            )
    return breaches
