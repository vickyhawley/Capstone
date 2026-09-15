"""Eval runner. CLI entry point.

Usage:
    groundwork-evals \\
      --dataset datasets/fixtures/harness-smoke.jsonl \\
      --thresholds thresholds/fixtures.json \\
      --sprint 1 \\
      --api-url https://groundwork-api.vercel.app

Exit codes:
  0 — all thresholds met.
  1 — one or more thresholds breached.
  2 — configuration / dataset / infrastructure problem before scoring.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .client import ApiClient, ApiError
from .metrics import METRICS, MetricResult, aggregate
from .schema import ApiResponse, DatasetError, EvalCase, load_dataset
from .thresholds import KNOWN_PROVENANCES, Breach, ThresholdConfig, find_breaches, load_thresholds


def normalize_provenance(raw: str) -> str:
    """Reduce a free-text provenance string to a known class name.

    Per the dataset spec (`evals/datasets/README.md`), each case's
    `provenance` is free text prefixed with one of the three allowed
    class names — but the actual JSONL uses variants like
    `real-customer-enquiry — NFCS social DM export...`. This function
    matches on the longest known prefix that's a whole-word match, so
    `real-customer-enquiry` maps to `real-customer` and
    `constructed-adversarial — prompt injection...` maps to
    `constructed-adversarial`.

    Raises ValueError if no known prefix matches — a data-quality
    failure the operator should see, not silently bucket into
    'unknown'.
    """
    # Sort longest-first so `constructed-adversarial` matches before
    # a hypothetical `constructed` prefix would.
    for known in sorted(KNOWN_PROVENANCES, key=len, reverse=True):
        if raw.startswith(known):
            # Ensure it's a whole-word match (either end of string or
            # followed by a non-alphanumeric char) so a hypothetical
            # `real-customer-something-unrelated` doesn't map here by
            # accident.
            rest = raw[len(known) :]
            if not rest or not (rest[0].isalnum() or rest[0] == "-"):
                return known
            # A trailing hyphen is part of some existing values (e.g.
            # `real-customer-enquiry`). Treat those as belonging to
            # the root class.
            if rest[0] == "-":
                return known
    raise ValueError(f"provenance '{raw}' does not start with a known class")


@dataclass
class CaseOutcome:
    case_id: str
    intent: str
    expected_behavior: str
    error: dict[str, Any] | None = None
    response: dict[str, Any] | None = None
    metrics: dict[str, dict[str, Any]] = field(default_factory=dict)


def _run_metrics(case: EvalCase, response: ApiResponse) -> dict[str, MetricResult]:
    return {name: fn(case, response) for name, fn in METRICS.items()}


def _empty_metrics_for_error(case: EvalCase, reason: str) -> dict[str, MetricResult]:
    """When the API failed, every metric is not applicable — with a
    reason string that names the failure so the results file is
    debuggable rather than mysteriously all-zero."""
    return {name: MetricResult(0.0, reason, applicable=False) for name in METRICS}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="groundwork-evals", description="Groundwork eval runner")
    p.add_argument("--dataset", type=Path, required=True, help="Path to JSONL dataset")
    p.add_argument("--thresholds", type=Path, required=True, help="Path to threshold JSON config")
    p.add_argument("--sprint", type=str, required=True, help="Sprint tag for results directory")
    p.add_argument("--api-url", type=str, required=True, help="Base URL of the deployed API")
    p.add_argument(
        "--results-dir",
        type=Path,
        default=Path("results"),
        help="Directory to write results into. Default: ./results",
    )
    p.add_argument("--timeout", type=float, default=30.0, help="Per-request timeout in seconds")
    return p.parse_args(argv)


def run(args: argparse.Namespace) -> int:
    try:
        cases = load_dataset(args.dataset)
    except DatasetError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    try:
        thresholds = load_thresholds(args.thresholds)
    except (FileNotFoundError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    client = ApiClient(base_url=args.api_url, timeout_s=args.timeout)

    per_case_results: list[CaseOutcome] = []
    per_metric_lists: dict[str, list[MetricResult]] = {name: [] for name in METRICS}

    for case in cases:
        outcome_container = CaseOutcome(
            case_id=case.id,
            intent=case.intent,
            expected_behavior=case.expected_behavior,
        )
        outcome = client.answer(case.user_input)
        if isinstance(outcome, ApiError):
            outcome_container.error = {"kind": outcome.kind, "detail": outcome.detail}
            metrics = _empty_metrics_for_error(case, f"api {outcome.kind}: {outcome.detail}")
        else:
            outcome_container.response = outcome.model_dump()
            metrics = _run_metrics(case, outcome)

        outcome_container.metrics = {
            name: {
                "score": r.score,
                "reason": r.reason,
                "applicable": r.applicable,
            }
            for name, r in metrics.items()
        }
        for name, r in metrics.items():
            per_metric_lists[name].append(r)
        per_case_results.append(outcome_container)

    aggregates = aggregate(per_metric_lists)
    breaches: list[Breach] = find_breaches(aggregates, thresholds.overall)

    # Per-intent breakdowns. ADR-0010 (router) and ADR-0011 (safety
    # gate) both argue the aggregate hides class-specific problems —
    # welfare-clinical at n=4 disappears into the mean. Emit per-class
    # tables so misdispatch is visible per class in the results file.
    per_intent_breakdowns = {
        "intent_classification_accuracy": _per_intent_metric(
            cases, per_case_results, "intent_classification_accuracy"
        ),
        "correct_behavior_dispatch": _per_intent_metric(
            cases, per_case_results, "correct_behavior_dispatch"
        ),
    }

    # Per-provenance aggregates + per-slice threshold checks (GW-14).
    # This is what makes the "tier 3 = red-team set" README claim
    # enforceable — the constructed-adversarial slice can be gated at
    # stricter floors than the overall aggregate without a separate
    # runner invocation.
    per_provenance_aggregates = _per_provenance_aggregates(cases, per_metric_lists)
    for provenance, aggs in per_provenance_aggregates.items():
        slice_thresholds = thresholds.by_provenance.get(provenance, {})
        breaches.extend(find_breaches(aggs, slice_thresholds, provenance=provenance))

    write_results(
        args.results_dir,
        args.sprint,
        args.api_url,
        str(args.dataset),
        str(args.thresholds),
        aggregates,
        thresholds,
        breaches,
        per_case_results,
        per_intent_breakdowns,
        per_provenance_aggregates,
    )

    if breaches:
        print("Threshold breaches:", file=sys.stderr)
        for b in breaches:
            direction = ">=" if b.higher_is_better else "<="
            slice_label = f" [{b.provenance}]" if b.provenance else ""
            print(
                f"  - {b.metric}{slice_label}: score={b.score:.3f}, "
                f"must be {direction} {b.threshold:.3f}",
                file=sys.stderr,
            )
        return 1
    return 0


def _per_provenance_aggregates(
    cases: list[EvalCase],
    per_metric_lists: dict[str, list[MetricResult]],
) -> dict[str, dict[str, Any]]:
    """Split each metric's per-case results by provenance, aggregate each.

    Returns `{provenance: {metric: Aggregate}}`. Empty slices are
    omitted — if the dataset has no `constructed-adversarial` cases,
    that key doesn't appear.
    """
    # Bucket case indices by normalised provenance.
    indices_by_provenance: dict[str, list[int]] = {}
    for i, case in enumerate(cases):
        prov = normalize_provenance(case.provenance)
        indices_by_provenance.setdefault(prov, []).append(i)

    out: dict[str, dict[str, Any]] = {}
    for provenance, indices in indices_by_provenance.items():
        sliced: dict[str, list[MetricResult]] = {
            metric: [per_metric_lists[metric][i] for i in indices]
            for metric in per_metric_lists
        }
        out[provenance] = aggregate(sliced)
    return out


def _per_intent_metric(
    cases: list[EvalCase],
    outcomes: list[CaseOutcome],
    metric: str,
) -> dict[str, dict[str, Any]]:
    """Per-intent breakdown of a binary (0/1) metric.

    Reads directly from the per-case outcomes rather than recomputing.
    Groups by the case's *actual* intent so the reported number is
    per-class accuracy on that metric. Used for both the router
    (intent_classification_accuracy) and the safety gate
    (correct_behavior_dispatch) — same aggregate-hides-class-problems
    concern applies to both per their respective ADRs.
    """
    by_intent: dict[str, dict[str, int]] = {}
    for case, outcome in zip(cases, outcomes):
        m = outcome.metrics.get(metric)
        if m is None or not m.get("applicable", True):
            continue
        bucket = by_intent.setdefault(case.intent, {"correct": 0, "total": 0})
        bucket["total"] += 1
        if m["score"] >= 1.0:
            bucket["correct"] += 1
    return {
        intent: {
            "correct": v["correct"],
            "total": v["total"],
            "accuracy": v["correct"] / v["total"] if v["total"] else 0.0,
        }
        for intent, v in sorted(by_intent.items())
    }


def write_results(
    results_dir: Path,
    sprint: str,
    api_url: str,
    dataset_path: str,
    thresholds_path: str,
    aggregates: dict[str, Any],
    thresholds: ThresholdConfig,
    breaches: list[Breach],
    cases: list[CaseOutcome],
    per_intent_breakdowns: dict[str, dict[str, dict[str, Any]]] | None = None,
    per_provenance_aggregates: dict[str, dict[str, Any]] | None = None,
) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    sprint_dir = results_dir / f"sprint-{sprint}"
    sprint_dir.mkdir(parents=True, exist_ok=True)
    out_path = sprint_dir / f"{timestamp}.json"

    payload = {
        "sprint": sprint,
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "api_url": api_url,
        "dataset_path": dataset_path,
        "thresholds_path": thresholds_path,
        "n_cases": len(cases),
        "summary": {
            name: {
                "score": agg.score,
                "n_applicable": agg.n_applicable,
                "n_total": agg.n_total,
                "higher_is_better": agg.higher_is_better,
            }
            for name, agg in aggregates.items()
        },
        "thresholds": {
            "overall": thresholds.overall,
            "by_provenance": thresholds.by_provenance,
        },
        "breaches": [asdict(b) for b in breaches],
        "cases": [asdict(c) for c in cases],
    }
    if per_intent_breakdowns:
        # Emit under a per-metric key so the results file can carry
        # breakdowns for multiple metrics side-by-side without shape
        # collisions.
        payload["per_intent_breakdowns"] = per_intent_breakdowns
    if per_provenance_aggregates:
        payload["per_provenance"] = {
            provenance: {
                metric: {
                    "score": agg.score,
                    "n_applicable": agg.n_applicable,
                    "n_total": agg.n_total,
                    "higher_is_better": agg.higher_is_better,
                }
                for metric, agg in aggs.items()
            }
            for provenance, aggs in per_provenance_aggregates.items()
        }
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=False)
    return out_path


def main() -> None:
    args = parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()
