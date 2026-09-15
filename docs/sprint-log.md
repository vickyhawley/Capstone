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

### Post-deploy tidy-ups (added after GW-09 landed)
Three follow-ups spun out of the deploy session, all shipped:
- Smoke check — `scripts/smoke.mjs` (Node ESM, no deps) asserts 200 +
  `rateLimit.configured: true` on both origins and that the web-origin
  payload matches the API's. Runs via `pnpm smoke` locally and via
  `.github/workflows/smoke.yml` on push-to-main + hourly cron. Every
  failure recorded in the config-drift section above would have been
  caught by this in seconds.
- Deploy pattern rewritten — the link-swap dance is deleted. Each app
  owns its own `.vercel/`; deploys are `vercel --prod --cwd apps/<app>`
  from the repo root. `.gitignore` reverted to just `.vercel/`. README
  deploy section updated accordingly.
- `docs/ai-assisted-development.md` — added a Sprint 1 prep entry
  covering the four config drifts in structured form (Asserted / True /
  Found by / Locally detectable). Frame: internal consistency is not
  external correctness; the counter-move is deploying the thin shell
  first, before elaborating.

### Vercel plan constraint (noted, not fixed)
The web project was renamed `capstone-web` → `groundwork-web` in the
Vercel dashboard, but the public alias stays as `capstone-web-ten.vercel.app`
because Hobby-plan projects can't add new `*.vercel.app` aliases after
creation. Documented in README; the URL is centralised in
`scripts/smoke.mjs` so a future rename (or plan upgrade) is a
three-file change, not a scavenger hunt.

### Scope change — GW-01 amended for attribute extraction (2026-09-15)
GW-01 ("corpus ingestion") is expanded, not split into a new story.
The board stays at 37; the story now includes an LLM attribute-extraction
pass at ingest. Recorded here rather than added silently so the amendment
is visible.

**Why.** A pre-handover profile of the 398-product catalogue found that
the facts customers actually ask about (size, feeding rate, waterproof
rating, ingredients) sit in prose but are largely absent from structured
metafields — an Equidry Aura description states 20,000 mm waterproof
rating and 32,000 g/m²/24hr breathability in the body, while the
`outerwear-clothing-features` metafield is populated on only 5 of 398
products. Retrieval alone can find those descriptions, but a bot cannot
*filter* on "waterproof ≥ 15,000 mm" without the fact being addressable.
Extraction at ingest turns prose facts into structured metadata a
retriever and a downstream substitute-ranker can both use.

**Amended acceptance criteria.**
- Extraction coverage reported per attribute per product type,
  before/after the catalogue-only baseline.
- Agreement rate against populated Shopify metafields (109 colour
  ground-truth products) reported and land in ADR-0004.
- Zero stored attributes without a source span, enforced by a test.
- Retrieval relevance on the golden set measured with and without
  extracted attributes in the chunk. Negative result reported honestly
  if the number doesn't move.

**Delivery split as planned.** GW-01 stays one story but ships in two
commits: (a) chunker library + attribute extractor + fixture guide +
inline snapshot tests, then (b) `@supabase/supabase-js` + persistence
to `documents`/`chunks` + ingestion runbook. Story closes when (b)
lands. Logging the split now — the discovery of GW-09's "close-time
surprise" pattern (the deploy defects that had to be caught in-flight)
is the trigger for making delivery shape visible up front.

**ADR renumbering.** Adding attribute extraction takes ADR-0004; the
originally-planned chunking-strategy ADR slides to ADR-0006. Substitute
ranking (introduced by the same brief as a Sprint 3 decision) takes
ADR-0005. ADR-0001's follow-up list already reflects the new numbering.

**Also carried by the brief.** ADR-0005 records substitute-ranking as
a decision only for Sprint 1 — no build until GW-19 in Sprint 3 — so
that the chunk metadata designed by ADR-0004 already carries the
fields substitute ranking will need (product type, vendor, comparable
attributes). Avoids a re-ingest at Sprint 3.

**Failure mode to watch.** If extraction produces attributes that read
as plausible but aren't grounded in the text, stop and surface it
rather than tightening the prompt to look right. That failure mode is
the whole reason for the source-span requirement.

### Didn't ship
- (Nothing outstanding from this sprint prep.)

### Eval delta
- N/A — harness ships this sprint; first real numbers land in Sprint 1
  proper.

### Decisions / ADRs
- ADR-0001 revised (filtered search, ts_rank, fusion grid, embedding
  commitment, migration cost).
- ADR-0003 landed — corpus composition (two document types).
- ADR-0004 in draft — attribute extraction at ingest.
- ADR-0005 planned — substitute ranking (decision only, Sprint 3 build).

### Follow-ups carried
- Real answer endpoint on the API so the harness can score more than
  "endpoint not implemented" — Sprint 1.
- Real 40-case dataset (authored separately) — Sprint 1.
- ADR-0006 (chunking strategy), ADR-0007 (retrieval query filters),
  ADR-0008 (fusion strategy addendum), ADR-0009 (synonym dictionary) —
  Sprint 1+.
