# Sprint log

One entry per sprint. Assessed as evidence of the improvement curve — do
not rewrite past entries.

## Format

```
## Sprint N — <dates>

### Goal
One sentence.

### Shipped
- [GW-##] <story> — <PR link>

### Didn't ship (and why)
- [GW-##] <story> — <reason>

### Eval delta
- Groundedness: X → Y
- Correct abstention: X → Y
- False refusal: X → Y
- Notes:

### Decisions / ADRs
- ADR-000N: <title>

### Follow-ups carried
- ...
```

## Sprint 0 — scaffold (this repo)

### Goal
Deployable skeleton: web shell + API health + SSE stream verified end to
end, CI green, port interfaces defined, ADR-0001 opened.

### Shipped
- Repo, workspace, CI, ports, adapters (stubs), migration 001, ADR-0001
  (decision deferred), README, deploy path.

### Didn't ship
- Anything Sprint 1+.

### Eval delta
- N/A — no eval harness yet.

### Decisions / ADRs
- ADR-0001: hybrid retrieval — decision deferred pending Sprint 1
  measurement.

### Follow-ups carried
- Wire real adapters as their stories land.
- Populate `evals/results/` from Sprint 1.

## Sprint 1 prep — corrections + eval harness

### Goal
Correct six defects surfaced in the Sprint 0 review, add the eval
harness skeleton, and close GW-09 (public URL live).

### Backlog change — GW-37 added to a frozen backlog
Scope was frozen at 36 stories at the start of Sprint 0. GW-37 (per-IP
rate limiting on the API, Upstash Redis) was added mid-week-one. This is
recorded here so the change is visible against the "frozen backlog" rule.

**Why the rule was bent.** The Sprint 0 review flagged that the
LanguageModel adapter lands in Sprint 1 behind a public, unauthenticated
endpoint. Once that adapter is real, every request costs money to a
paid API. Retrofitting rate limiting after the first bill would be
worse than adding a story now. The alternative — leaving the endpoint
unrated until Sprint 2 — has an unbounded downside (spend, abuse) and
zero benefit. This is a week-one correction to Sprint 0's scope, not a
week-nine feature addition, and the distinction matters: a discovered
Sprint-0 defect should land in Sprint 1 prep, not compete for the
backlog with Sprint 3 features.

**How this stays honest.** No further mid-sprint backlog additions
without an equivalent entry in this log. GW-37 counts against the "36
stories" number: the board is now 37 and the graded submission will
report the change here rather than paper over it.

### Shipped
- GW-37: rate limiting middleware (Upstash Redis), fail-closed in prod.
- GW-09: both origins deployed and the same-origin rewrite verified end
  to end.
  - API: <https://groundwork-api.vercel.app/api/health> → 200.
  - Web: <https://capstone-web-ten.vercel.app/api/health> → same JSON via
    the rewrite in `apps/web/vercel.json`.
- ADR-0002 (iteration vs timeout): `MAX_ITERATIONS` dropped from 32 to 8
  so the iteration counter is reachable within the 25 s wall-clock
  budget. At 32 the counter was decorative — every stop was a torn
  timeout. Change is visible in `/api/health` at both origins.
- Filtered vector search strategy chosen (F2, over-fetch + fallback);
  ADR-0001 updated.
- `ts_rank` correction — sparse index note in ADR-0001 (it is not BM25).
- Fusion method folded into Sprint 1 experiment as a 2×3 grid with
  reranker.
- Embedding model committed (`text-embedding-3-small`, 1536 dims) with a
  migration-cost paragraph so a future swap is a considered decision.
- Migration 001 adds GIN on `chunks.metadata` for the F2 filter path.
- Eval harness skeleton (`evals/` Python package), three fixture cases
  clearly marked as harness self-test, evals.yml wired to the harness.

### Config drift found during GW-09 (fixed in-flight)
Four Sprint 0 scaffolding defaults that read plausibly from library docs
but broke at first deploy. Recording so the pattern is visible, not just
the fixes:
- `engines.node = >=24` and `.nvmrc = 24` — Vercel max is 22.x. Relaxed
  to `>=22 <23` / `22`.
- `apps/api/vercel.json` pinned `runtime: "@vercel/node@5.0.0"` —
  produced CJS `exports` in an ESM-typed package. Removed; default
  runtime handles ESM correctly.
- `apps/api/api/[[...route]].ts` used `hono/vercel`'s `handle(app)` as
  default export — modern Vercel Node runtime treats default exports as
  `(req, res) => void` and drops returned Responses, causing 60 s
  timeouts. Replaced with named HTTP-method exports delegating to
  `app.fetch`.
- Rate limiter read `UPSTASH_REDIS_REST_URL/TOKEN` — Vercel's Upstash
  Marketplace integration injects `KV_REST_API_URL/TOKEN` instead. Added
  fallback (accepts either shape), covered by four new unit tests.

### Didn't ship
- (Nothing outstanding from this sprint prep.)

### Eval delta
- N/A — harness ships this sprint; first real numbers land in Sprint 1
  proper.

### Decisions / ADRs
- ADR-0001 revised (filtered search, ts_rank, fusion grid, embedding
  commitment, migration cost).

### Follow-ups carried
- Real answer endpoint on the API so the harness can score more than
  "endpoint not implemented" — Sprint 1.
- Real 40-case dataset (authored separately) — Sprint 1.
- ADR-0002 through ADR-0005 as identified in ADR-0001 follow-ups.
