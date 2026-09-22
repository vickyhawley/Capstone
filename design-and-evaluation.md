# Design and evaluation

This is the design + evaluation document the AI Engineering Project brief
asks for. It's an index: the full material is in the documents linked
below, kept in their historical locations so cross-references from ADRs,
sprint log, and PR history don't rot.

## Design

- **[`docs/design-and-testing.md`](docs/design-and-testing.md)** —
  the assessed design and testing document (system overview,
  architectural decisions, software patterns, deployment options
  with cost implications, testing methodology). Ships as the
  MSSE-handbook-shaped "design and testing" artifact; the
  "design" half of what this file (design-and-evaluation) covers
  lives entirely there.
- **[`docs/adr/`](docs/adr/)** — 17 numbered Architecture Decision
  Records, one per load-bearing choice (retrieval strategy, safety
  gate, tool-loop termination, trace persistence, conversation
  memory, etc.). Each ADR names the decision, the alternatives
  considered, and why they were rejected. Referenced by number
  from the design document.
- **[`docs/sprint-log.md`](docs/sprint-log.md)** — running log of
  what shipped in each sprint, with honest gaps named where
  decisions turned out to be wrong or partial.

## Evaluation

- **[`evals/README.md`](evals/README.md)** — how the eval harness is
  built (Python package, talks to deployed API over HTTP, no shared
  code with the app), how to run it locally and in CI, and how the
  threshold-breach exit codes work.
- **[`evals/datasets/sprint-1/cases.jsonl`](evals/datasets/sprint-1/cases.jsonl)** —
  the golden dataset (65 cases). Sourced from real customer questions
  in the shop's social-DM export (May–Sep 2026), PII-stripped via
  `evals/scripts/strip_messages.py`. Typos preserved verbatim.
- **[`evals/groundwork_evals/metrics.py`](evals/groundwork_evals/metrics.py)** —
  the 10 metric implementations. Two required by the AI
  Engineering Project brief:
  - **`groundedness`** (§7 required: information-quality metric) —
    fraction of citations that appear in the case's
    `required_source_ids`. Detects citation drift and overtly wrong
    sources. Scores 0 on refused-when-should-answer, 0 when
    prohibited claims (e.g. dosages, clinical advice) appear.
  - **`latency`** (§7 required: system metric) — request wall-clock
    p50/p95/min/max/mean, computed over every case including error
    paths (so timeouts and 5xx contribute honestly rather than
    being excluded to make the number look better). Implementation:
    `evals/groundwork_evals/runner.py:_latency_summary` and
    `client.py` (uses `time.perf_counter()` for monotonic timing).
    Every case-row in the results file carries its own `latency_ms`
    for per-case debugging.
- **[`evals/thresholds/`](evals/thresholds/)** — per-sprint threshold
  gates. Runner exits non-zero when any threshold is breached; the
  results file names each breach with actual vs required score.
- **[`evals/results/`](evals/results/)** — historical results from
  every CI run, timestamped and versioned. Each file includes the
  full summary + per-case breakdown + per-provenance slice
  aggregates + latency summary.

## How the required brief metrics land in this file

| Brief §7 requirement | Where it lives |
|---|---|
| Groundedness | `evals/groundwork_evals/metrics.py::groundedness` |
| Citation accuracy | Same metric — the citation-overlap term is what "citation accuracy" measures. See ADR-0015 and design doc §7. |
| Latency (p50/p95) | `evals/groundwork_evals/runner.py::_latency_summary`; surfaced on every CI run and every results file. |
| 15–30 question eval set | 65 cases in `evals/datasets/sprint-1/cases.jsonl` — 2× the upper bound. |
