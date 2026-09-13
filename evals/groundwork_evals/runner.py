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
from .thresholds import Breach, find_breaches, load_thresholds


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
    breaches: list[Breach] = find_breaches(aggregates, thresholds)

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
    )

    if breaches:
        print("Threshold breaches:", file=sys.stderr)
        for b in breaches:
            direction = ">=" if b.higher_is_better else "<="
            print(
                f"  - {b.metric}: score={b.score:.3f}, must be {direction} {b.threshold:.3f}",
                file=sys.stderr,
            )
        return 1
    return 0


def write_results(
    results_dir: Path,
    sprint: str,
    api_url: str,
    dataset_path: str,
    thresholds_path: str,
    aggregates: dict[str, Any],
    thresholds: dict[str, float],
    breaches: list[Breach],
    cases: list[CaseOutcome],
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
        "thresholds": thresholds,
        "breaches": [asdict(b) for b in breaches],
        "cases": [asdict(c) for c in cases],
    }
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=False)
    return out_path


def main() -> None:
    args = parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()
