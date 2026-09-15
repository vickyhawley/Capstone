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

  - Commit (a) landed 2026-09-15 as `d2a8ac1`: `packages/ingestion/`
    with product + guide chunkers, attribute-extractor validation
    (source-span invariants enforced by test), typed attribute
    schemas for Feed / Bedding / Haylage / Supplements / Outdoor
    Rugs (colour common attribute across all), fixture guide
    `data/guides/rug-sizing.md`. 38 tests, all gates green.
  - Commit (b) landed 2026-09-15 as `030dd0b`: persistence to
    `documents`/`chunks`, gpt-4o-mini extractor with structured
    outputs, `packages/ingestion/src/ingest-cli.ts` runner behind
    `pnpm ingest`, `docs/runbooks/ingest.md`.
  - Commit (c) landed 2026-09-15 as `c04f1f1`: `--force` flag to
    override the content-hash fast-path when metadata (not text)
    changes between runs — needed to re-run extraction against
    already-persisted documents.
  - Commit (d) landed 2026-09-15 as `b96007e`: source-span
    verifier fix. First live run dropped 296 of 303 attributes on
    an offset-equality check that the model reliably failed while
    quoting correctly. Verifier switched to substring-in-source
    with server-side offset computation; drop rate collapsed to
    13 of 310. Not prompt-tightening; aligning the check with
    the grounding contract this story actually needs.
  - **GW-01 formally closes 2026-09-15.** Ingest run 2 against
    Supabase `vwmdtzwuetpebinflwbs`: 399 documents forced, 297
    attributes stored, 13 dropped (5 unsupported + 8 quote-not-in-source
    — guardrail catches, expected). Full addendum recorded at
    `docs/adr/0004-attribute-extraction.md#addendum---first-live-run-outcome-2026-09-15`.

    ADR-0004's 80% colour-agreement shipping gate was **not
    measured** — of 70 in-schema products with a populated `Color`
    metafield, only one had colour also named in the description
    text (the metafield records bag/pellet colour, which is rarely
    in prose). This is a finding about the ground-truth choice,
    not an extractor failure. Two follow-ups replace the
    unmeasurable gate:
    - Sprint 2 — hand-review spot check on 30 random stored
      attributes to verify against `source_span` and the actual
      description. Harder to cheat than proxy agreement rates.
    - Sprint 2 — widen the metafield-agreement validation set
      (from ADR-0004's original follow-up list) to `Animal feed
      form` and `Age group`, which are more likely to appear in
      descriptions than pellet colour.

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

### Fixtures ready for later stories (no build this sprint)

Two pieces of the synthetic order + catalogue data are structured so
that Sprint 2–3 stories can pick them up without rework. Noting here
so the fixture support is discoverable and so nobody re-invents it.

**Delivery-zone (GW-21 prep).** The catalogue has 105 products tagged
`local-delivery-only` (84 Feed, 8 Bedding, 6 Haylage, 7 other). This
is a real NFCS business rule, not synthetic — the tag is set on the
production catalogue export. The synthetic orders enforce the rule:
16 orders in `data/synthetic/orders.jsonl` have at least one
`local_delivery_only: true` line and a delivery district outside the
served radius; those are forced to `delivery_method: "collection"`.
When GW-21 (delivery-zone tool) builds, that 16-order subset is the
fixture data for the tool's collection-only rule — no need to invent
cases. The served districts named in `scripts/generate_orders.py`
match the postcodes that appear in customer messages.

**"Their usual" (Sprint 2+ candidate, no story yet).** The synthetic
order history models four client archetypes (regular, occasional,
at-risk, one-off) mirroring the production hub's segmentation. 49 of
60 clients are repeat buyers with staple baskets — deliberately so,
so a frequency-then-recency product-suggestion tool has meaningful
fixture data on day one rather than a one-row lookup. Not on the
Sprint 1 board; noting here so if a story lands later the data is
already shaped. If we skip it altogether, no cost — the archetype
weights in the generator can be tuned to whatever a future ADR
justifies.

### Customer discovery signals (2026-09-15)

Six signals shared by the shop owner around what customers value
today and what they're pulling the shop toward. Recorded so
Sprint 2+ planning has the context and the assistant's voice /
scope decisions can lean on it. Detailed rationale lives in
project memory (`project_nfcs_customer_signals.md`).

**What customers value today (assistant must not erode):**

1. **Rhinegold boots — try-on in shop.** Fit questions on
   Rhinegold boots should route to "come in and try", not
   online sizing. Do not attempt to size boots remotely on this
   brand.
2. **Sunday opening.** Concrete corpus fact —
   `data/guides/opening-hours.md` added this sprint as the
   canonical source. Placeholder hours need to be populated
   before next ingest.
3. **Technical products over clothing.** Competitors are moving
   toward clothing; the shop's differentiator is technical depth.
   ADR-0004's extraction (`waterproof_mm`, `breathability`,
   `active_ingredients`, `feeding_rate`) is directly in service
   of this positioning — the coverage report (`pnpm coverage`)
   confirms the technical axes are where extraction earned its
   cost.

**What customers are asking for (Sprint 2+ candidates, not on
the board):**

4. **Pet foods & supplies (dog, cat).** Currently catalogue
   Type `dog feed` has 1 product. Scope expansion signal — new
   attribute schemas needed (probable: species, life_stage,
   target_concern, pack_size_kg, form). No story yet; add when
   the shop authorises the expansion.
5. **High-end hat fitting (~£2,000 tier).** Hat fitting is a
   *service*, not a product. Assistant should escalate "which
   hat fits me?" to booking a fitting, not answer sizing
   online. Case-shape for the golden dataset: escalate under
   `welfare-clinical`-adjacent tag, or a new `service-referral`
   category. Flag when the SME authors golden cases.
6. **Basics tier alongside the premium.** Customers want
   access to a lower-priced entry point too. This is a
   price-tier dimension of substitute ranking — reinforces
   ADR-0005. Also introduces a new golden-dataset category
   `price-tier-substitute`, noted in `evals/datasets/README.md`
   §3 this sprint.

### Spec corrections found while authoring the first 10 cases (2026-09-15)

Three definitions in `evals/datasets/README.md` were too narrow to
describe the shape of real customer questions. Surfaced by writing
real cases against the doc; fixed before the next batch of authoring
so 30 more cases don't land against the wrong definitions. The
provenance matters: these came out of writing real cases, which is
evidence the authoring process works — the doc is a spec, and
authoring is how you catch spec bugs.

Fixes landed in the same commit as this entry:

- **`three-state-stock` covers both sides of the boundary.** The
  original discriminating test ("would a naive yes/no lose the
  sale?") only described the orderable side. Cases 3 (wormers) and
  8 (electric fencing) are the *negative* side: not held AND not
  obtainable. The naive "no" is correct; the failure mode is the
  opposite — the system over-hedging into a false offer to order.
  That side matters more than it sounds because a well-trained
  system reaches for the orderable phrasing by default, and
  offering to order something the shop can't get is a commitment
  the shop may be held to. Both sides now have their own
  discriminating test; single tag retained (rationale documented
  in the tag).
- **`prohibited_claims` polarity flips within the tag.** The doc
  listed collapse-to-no strings as the default. For negative-side
  cases those strings are the *correct* answer, so an author
  following the doc literally would populate strings that make a
  passing case impossible. Worked examples for both polarities
  added, with a word-boundary reminder (`"order"` alone would fire
  on *"in order to"*).
- **Ungroundable future-intent belongs in `out-of-scope`.** Case 6
  ("do you have any intention of adding Devon haylage") reads as a
  product question but has no corpus grounding — the answer lives
  in a staff decision that hasn't been made or written down. The
  original OOS boundary paragraphs emphasised *"about us as a
  business"* (staff pay, financials) and didn't name this shape.
  New paragraph added covering future-intent-about-products with
  case 6 as the canonical example, plus an explicit distinction
  from `three-state-stock`'s negative side (which is about
  *current* availability, not future intent).

Ten existing cases re-validated against the loader after the fixes —
no regressions. Cases weren't re-tagged; the tags were already
correct against the SME's intent, only the definitions needed to
catch up.

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
