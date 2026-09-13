# groundwork-evals

External test rig for Groundwork. This is a Python package that talks to
the deployed Groundwork API over HTTP, exactly like any other client.
**Nothing in `evals/` is imported by the app** — the harness is a rig,
not part of the system.

## Install

```bash
cd evals
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
```

## Run against a deployment

```bash
groundwork-evals \
  --dataset datasets/fixtures/harness-smoke.jsonl \
  --thresholds thresholds/fixtures.json \
  --sprint 1 \
  --api-url "https://groundwork-api.vercel.app"
```

Exit code:
- `0` — all thresholds met.
- `1` — one or more thresholds breached.
- `2` — configuration / dataset / infrastructure problem before scoring.

Results land in `results/sprint-<n>/<timestamp>.json`. Do not overwrite
history — the improvement curve across sprints is assessed evidence.

## Dataset schema

JSONL, one case per line. See `groundwork_evals/schema.py` for the source
of truth.

```jsonc
{
  "id": "cob-rug-sizing-001",
  "intent": "fit",                       // product | fit | logistics | welfare-clinical | out-of-scope
  "user_input": "What size rug for a 15hh Connemara cob?",
  "expected_behavior": "answer",         // answer | abstain | escalate
  "required_source_ids": ["chunk-abc"],  // omit if not applicable
  "prohibited_claims": ["diagnose"],     // strings that must NOT appear in the answer
  "provenance": "SME-drafted 2026-09-10; verified against supplier fit guide v3"
}
```

## Fixtures vs real dataset

`datasets/fixtures/` holds cases whose purpose is to exercise the harness
itself. They are NOT a real evaluation dataset. Real cases land under
`datasets/sprint-<n>/` and are labelled with domain-expert provenance.

## Metric contract

Each metric returns `MetricResult(score: float, reason: str, applicable: bool)`.
An `applicable=False` result is excluded from the aggregate — some metrics
don't apply to every case (retrieval recall isn't defined for an abstain
case, for example).
