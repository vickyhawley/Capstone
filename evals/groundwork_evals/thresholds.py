"""Threshold loading and breach detection.

A threshold config is a JSON file mapping metric name → threshold value.
For metrics where higher is better, `score >= threshold` passes. For
metrics where lower is better (false_refusal), `score <= threshold`
passes.

Metrics not mentioned in the config are unconstrained (no gate).

**GW-14 addition — per-provenance thresholds.** The dataset spec at
`evals/datasets/README.md` describes three provenance classes
(`real-customer`, `constructed-boundary-probe`, `constructed-adversarial`)
and prescribes per-slice measurement so real-world numbers can't
absorb adversarial failures. A threshold config may include a
`by_provenance` object whose keys are provenance class names and whose
values are per-metric threshold dicts. Overall + per-slice thresholds
are checked independently — a per-slice breach fires an exit-code-1
even if the overall aggregate passes.

Example:

```json
{
  "intent_classification_accuracy": 0.85,
  "by_provenance": {
    "constructed-adversarial": {
      "intent_classification_accuracy": 1.00
    }
  }
}
```
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from .metrics import HIGHER_IS_BETTER, Aggregate

# The three provenance classes the dataset README declares. Any
# provenance value in the JSONL must reduce (via
# `normalize_provenance` in runner.py) to one of these.
KNOWN_PROVENANCES: frozenset[str] = frozenset(
    {"real-customer", "constructed-boundary-probe", "constructed-adversarial"}
)


@dataclass(frozen=True)
class Breach:
    metric: str
    score: float
    threshold: float
    higher_is_better: bool
    # None for overall breaches; a provenance class name for per-slice.
    provenance: str | None = None


@dataclass(frozen=True)
class ThresholdConfig:
    """Overall + per-slice thresholds parsed from the config JSON."""

    overall: dict[str, float] = field(default_factory=dict)
    by_provenance: dict[str, dict[str, float]] = field(default_factory=dict)


def _parse_metric_map(source: str, raw: dict[str, object]) -> dict[str, float]:
    """Validate a {metric: threshold} dict from the config JSON."""
    out: dict[str, float] = {}
    for metric, threshold in raw.items():
        if metric not in HIGHER_IS_BETTER:
            raise ValueError(f"{source}: unknown metric '{metric}'")
        if not isinstance(threshold, (int, float)) or isinstance(threshold, bool):
            raise ValueError(f"{source}: threshold for '{metric}' must be numeric")
        out[metric] = float(threshold)
    return out


def load_thresholds(path: Path) -> ThresholdConfig:
    if not path.exists():
        raise FileNotFoundError(f"Threshold config not found: {path}")
    with path.open("r", encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        raise ValueError(f"{path}: threshold config must be an object")

    by_provenance_raw = raw.pop("by_provenance", None)
    overall = _parse_metric_map(str(path), raw)

    by_provenance: dict[str, dict[str, float]] = {}
    if by_provenance_raw is not None:
        if not isinstance(by_provenance_raw, dict):
            raise ValueError(f"{path}: 'by_provenance' must be an object")
        for prov, prov_thresholds in by_provenance_raw.items():
            if prov not in KNOWN_PROVENANCES:
                raise ValueError(
                    f"{path}: unknown provenance '{prov}' — must be one of {sorted(KNOWN_PROVENANCES)}"
                )
            if not isinstance(prov_thresholds, dict):
                raise ValueError(f"{path}: by_provenance['{prov}'] must be an object")
            by_provenance[prov] = _parse_metric_map(f"{path}#by_provenance.{prov}", prov_thresholds)

    return ThresholdConfig(overall=overall, by_provenance=by_provenance)


def find_breaches(
    aggregates: dict[str, Aggregate],
    thresholds: dict[str, float],
    provenance: str | None = None,
) -> list[Breach]:
    """Compare a set of aggregates against a metric→threshold map.

    `provenance` is stamped on each Breach when this is a per-slice
    check; leave None for the overall run so the breach reader can
    render "overall" vs "adversarial slice" distinctly.
    """
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
                    provenance=provenance,
                )
            )
    return breaches
