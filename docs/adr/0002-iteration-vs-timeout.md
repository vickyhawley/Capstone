# ADR-0002 — Iteration bound must be reachable before the wall-clock timeout

- **Status:** Accepted (2026-09-13, Sprint 1 prep)
- **Supersedes:** the Sprint 0 sizing of `MAX_ITERATIONS = 32` and the
  "sized generously" comment in `apps/api/src/limits.ts`.

## Context

Two per-request budgets guard the pipeline:

- `MAX_ITERATIONS` — an integer cap on loop passes (planner iterations,
  tool-call retries, retrieval passes).
- `TIME_BUDGET_MS` — a wall-clock cap, enforced via `AbortSignal`.

Both were sized in Sprint 0 without a realistic cost model for what one
iteration actually costs. The values landed at `MAX_ITERATIONS = 32` and
`TIME_BUDGET_MS = 25_000` — visible in the `/api/health` payload:

```json
"limits": { "maxIterations": 32, "timeBudgetMs": 25000 }
```

At Sprint 1's realistic per-iteration cost (LLM round-trip ≈ 2–5 s), 32
iterations take 60–160 s — well past 25 s. So the iteration bound never
fires; the timeout always fires first. The counter is decorative.

## Why decorative bounds are worse than no bound

A stopped-at-iteration event is a **clean boundary**: the pipeline
finishes the current step (writing a trace row, emitting a final SSE
event, decrementing a token account) before returning. A stopped-at-
timeout event is a **torn boundary**: the AbortSignal fires mid-step,
which produces:

- Half-written traces (harder to debug an incident from).
- Torn SSE streams (client sees a hang or a partial JSON blob).
- Uncounted tool calls (retry/budget accounting drifts).

The reason to have both budgets is that each covers a different failure
mode:

- **Iteration bound** stops a well-behaved but overly optimistic plan
  from consuming too many discrete steps.
- **Timeout** stops a single stuck step (hung network call, slow model,
  regexp-bomb tokenizer) that the iteration counter cannot see because
  it never advanced.

If the iteration bound can never fire, we lose the first defence and
every stop is torn.

## Decision

Size `MAX_ITERATIONS` so it is **reachable within the time budget** at
realistic per-iteration cost, so the counter can be the primary stop:

- Assumed realistic per-iteration cost: **≈ 3 s** (LLM call + tool call +
  bookkeeping). Sprint 1 will measure the actual value and revisit.
- Budget for iterations: leave ≥ 1 s of the 25 s window as headroom.
- `MAX_ITERATIONS = ⌊(25 − 1) / 3⌋ = 8`.

The timeout stays at 25 s and becomes the safety net for the stuck-step
failure mode, not the primary stop.

## Consequences

- `MAX_ITERATIONS` drops from 32 to 8 in `apps/api/src/limits.ts`.
- The comment on `MAX_ITERATIONS` is rewritten: "sized generously"
  removed, sizing argument stated, ADR linked.
- The comment on `TIME_BUDGET_MS` is amended to explicitly name it as the
  safety net rather than the primary stop.
- `/api/health` responses immediately reflect the new value — the
  Sprint 0 scaffold's `maxIterations: 32` was the trigger for this ADR,
  so it's fitting that the fix is visible in the same endpoint.

## When to revisit

Two triggers:

1. Sprint 1 measures actual per-iteration cost. If it lands materially
   above 3 s (say, 5 s), drop `MAX_ITERATIONS` to 4. If materially below
   (say, 1 s), raise it — but check whether the higher-iteration
   behaviour is desirable before spending latency on it.
2. If we start streaming intermediate tokens back to the client, the
   time budget probably needs to grow (SSE keep-alive tolerates longer
   requests). Re-derive `MAX_ITERATIONS` from the new budget.

## Follow-ups

- Add a per-endpoint budget when Sprint 1's `/api/answer` lands
  (retrieval-only requests need a tighter window than synthesis).
- Emit `iterations_used` and `time_budget_used_ms` in the trace so the
  ratio can be monitored — if 90% of requests hit the iteration bound
  and 10% hit the timeout, the split is healthy; if it inverts, the
  sizing is wrong again.
