# ADR-0016 — Stock lookup: three-state semantics, chunks-backed catalogue, out-of-scope list

- **Status:** Proposed (2026-09-17, Sprint 3 planning — this ADR
  precedes the GW-20 implementation. Same discipline as
  ADR-0013/0014/0015 preceded their stories.)
- **Deciders:** Vix Hawley (author), supervisor (approver).
- **Related stories:** GW-20 (this ADR — stock lookup tool).
  GW-18 registers this tool with the loop. GW-19 (substitute
  ranking) runs when this tool returns `orderable` or
  `unavailable` — same input surface, different question.
  GW-25 persists the tool span this tool emits.
- **Related ADRs:** ADR-0010 (intent router — this ADR asks it
  to emit an entity extraction as an additional descriptive
  field), ADR-0011 (safety gate — the loop only enters when
  the gate emits `answer`), ADR-0014 (tool loop — this is the
  first real tool it dispatches; Tier 1 route-based dispatch
  is where this tool receives its args), ADR-0005 (substitute
  ranking — sibling tool that runs on this tool's non-exact
  outputs), ADR-0013 (deterministic chunk IDs — this tool
  returns chunk IDs, they must be durable across re-ingests).
- **Related README:** the "deterministic facts (stock, sizing,
  delivery zones) come from tools. The model never answers them
  from its own knowledge" rule (§Non-negotiable rules) is the
  load-bearing claim this ADR implements the first of.

## Context

Sprint 3 Story 4 (GW-20) is the load-bearing product-intent
tool. ADR-0014 named it as the first Tier-1 candidate: a query
routed with `intent: product` + an extracted product handle
dispatches a tool call whose result is the answer's substrate
for stock claims.

## Framing note — this tool is not deterministic

The Sprint 3 plan row for Story 4 calls this tool "Deterministic
(against catalogue)" and ADR-0014's Tier 1 section uses the same
word. Both frames overclaim. The tool's decision logic (§2) is
hybrid retrieval with a similarity threshold — the same
probabilistic substrate as the retriever, because chunks-as-
catalogue means the catalogue lookup IS the retrieval query.
Lookup by handle against a structured `products` table would be
deterministic; nearest-neighbour over prose isn't.

The load-bearing claim this ADR actually makes is not
"deterministic" but **"stock status is sourced from the
catalogue rather than from model knowledge."** That's true, it's
what the README's non-negotiable rule requires, and it's what
distinguishes GW-20 from a model-invented answer. Nothing
downstream should describe this tool as deterministic; when
that word appears in Sprint-log rows or older ADR text
referencing GW-20, it should be read as shorthand for the
above.

The sprint-log Story 4 row and ADR-0014 §Tier 1 both retain the
word for now (editing them mid-sprint is more churn than
clarity). Story 4 close-out amends both.

Two things about "the catalogue" turned out to matter more than
the plan assumed:

1. **The `products` table exists in migration 001 but was never
   populated.** Ingestion writes to `documents` + `chunks` only.
   Product metadata (`handle`, `vendor`, `type`, `tags`,
   `price_min`, `price_max`, `variant_count`,
   `local_delivery_only`) lives in `chunks.metadata` for product-
   type content. Sprint 1's original design assumed a separate
   structured table; four sprints later, chunks-with-metadata
   won on practice — no separate write path to maintain, one
   source of truth for retrieval + facts.

2. **"Three-state stock" is not a quantity check.** The golden
   dataset's `three-state-stock` tag maps to three shop-behaviour
   shapes, not to `stock_level > 0`:

   - **exact** — product held in-store now (case 005 Burley
     bale, case 041 Badminton chicken feed £9, case 047
     Burlybed, case 048 hemp bedding satisfied by Aubiose).
   - **orderable** — not held, but within NFCS's sourcing scope;
     the shop offers to get it in (case 044 Western Timothy,
     case 045 Haygates balancer, case 046 Saracens veteran
     balancer, case 049 bagged barley/oat straw, case 001
     Molichaff Hoofkind).
   - **unavailable** — not held AND out of NFCS's scope; the
     shop cannot supply (case 003 wormers — vet-prescription
     category, case 008 electric fencing — out of category,
     case 042 Simple Systems red bag — supplier NFCS
     confirmed they cannot source from).

   The distinction between `orderable` and `unavailable` is
   not derivable from catalogue absence alone. It requires a
   canonical "what NFCS won't source" list — same shape as the
   customer-signals project memory (`project_nfcs_customer_signals.md`):
   sourcing scope is a business fact that has to be captured
   from the shop, not inferred from what's already in the corpus.

## What this ADR decides

**Seven decisions.**

### 1. Data source: chunks table + SME-curated out-of-scope list

The tool reads:

- `chunks` where `documents.content_type = 'product'` — the same
  substrate the hybrid retriever (ADR-0001) already indexes.
  Match uses hybrid retrieval (dense + BM25 with RRF from
  ADR-0001) filtered to product-type chunks. No new index, no
  new query path.
- `data/nfcs-out-of-scope.yaml` — a small SME-curated file
  listing categories and brands NFCS confirms they will not
  source.

**The seed is provisional and must not close the loop against
the golden set alone.** Deriving the initial entries from cases
003 (wormers), 008 (electric fencing), 042 (Simple Systems)
makes the seed circular — `stock_status_correct` would hit 1.00
on those cases by construction because the list matches itself.
Any threshold measured against that shape is meaningless: it's
"the list correctly recognises entries in the list," not "the
list correctly captures NFCS's sourcing scope."

The un-hack:

- Ship the provisional seed (cases 003, 008, 042) marked
  `provisional: test-derived` in the YAML so future readers
  don't mistake it for validated data.
- **Before Story 4 close-out**, a five-minute conversation with
  NFCS gets the actual won't-source categories from the shop
  owner. This turns the metric from circular into real.
- The SME-derived entries land in the same YAML with the
  provisional flag removed. Golden-set-derived entries retain
  the flag until a golden-case coincidentally happens to test
  one of the SME categories.
- Story 4 close-out records which entries were provisional vs
  SME-sourced and whether the SME conversation happened. If it
  did not happen, the metric's floor is annotated as
  "circular — SME conversation still owed" and re-measured
  once the seed is real.

Additions to the list after Sprint 3 are curation, not code.
The point of the YAML is that a business-fact change doesn't
require a code change — the shop owner adds a line, ingestion
picks it up on next boot.

The `products` table stays in schema for Sprint 3 (removing it
requires a migration that touches Sprint 1 code, out of scope
for a Story-4 close-out). Sprint 4 cleanup: either populate it
via ingestion or drop it. Named as a Sprint 4 candidate in the
sprint-log.

**Why not `products`:** it's empty, has no writer, and rebuilding
the ingestion path to fill it would delay Story 4 for a design
the corpus already covers. Chunks-with-metadata is the source
of truth for what NFCS holds; forcing a second copy is exactly
the "producer-ahead-of-consumer" fragility ADR-0015 warned
about, in advance.

### 2. Three-state semantics

```
tool.args:  { productQuery: string, minMatchScore?: number }
tool.result (ok:true, value):
  { status: 'exact' | 'orderable' | 'unavailable',
    matchedChunkIds: string[],
    matchedHandle: string | null,
    matchedTitle: string | null,
    outOfScopeReason: string | null }
```

Decision logic:

```
matches = hybridRetrieve(productQuery, contentType='product', k=5)
if matches.length > 0 && matches[0].score >= minMatchScore:
  return { status: 'exact', matchedChunkIds: matches.map(id),
           matchedHandle: matches[0].metadata.handle,
           matchedTitle: matches[0].document.title,
           outOfScopeReason: null }

if productQuery matches an entry in nfcs-out-of-scope.yaml
  (case-insensitive substring or category-tag match):
  return { status: 'unavailable', matchedChunkIds: [],
           matchedHandle: null, matchedTitle: null,
           outOfScopeReason: <entry.reason> }

return { status: 'orderable', matchedChunkIds: [],
         matchedHandle: null, matchedTitle: null,
         outOfScopeReason: null }
```

Ordering matters: `exact` beats `unavailable` beats `orderable`.
If a product is both in the corpus AND on the out-of-scope list,
the corpus wins — the corpus is a fact about what NFCS has done,
the out-of-scope list is a policy about what they won't do; the
former overrides the latter (a shipped product isn't hypothetical).

**`matchedHandle` returns the top hit's handle, not a fuzzy
"maybe you meant" set.** Substitute suggestions are GW-19's job
(ADR-0005). This tool is single-answer per call; the loop can
call it again with a different query if the planner disagrees.

### 3. `minMatchScore`: safe provisional default, characterised at close-out

Same "descriptive-first, threshold-second" discipline as
ADR-0010 (intent classification) and ADR-0014 (`tool_backed_claim`):
Sprint 3 close-out for Story 4 measures the score distribution
for every product-intent golden case and names the floor at
whichever value distinguishes real matches from noise on the
corpus we have.

**But an accept-any-match default is unsafe in the direction §4
says can't happen.** A wrong extraction ("wormers", "electric
fencing") will retrieve *something* — the nearest feed or fencing-
adjacent chunk — and if any match wins, that becomes `exact` and
the tool falsely claims the shop stocks a product they don't.
That's exactly the false-availability failure the negative three-
state cases (003, 008, 042) exist to catch, and a `null` default
manufactures the failure by construction.

The default is therefore:

- **Provisional floor: `0.5`** on the hybrid retriever's RRF-
  normalised score. Sized conservatively so that borderline
  retrievals fall through to `orderable` (safe) rather than
  becoming `exact` (unsafe). Not a measured number yet — this is
  a defensive floor before we have distribution data, not the
  final threshold.
- **Once close-out has the distribution**, the provisional 0.5
  is either confirmed, tightened, or (if the data justifies)
  loosened. The measured value replaces the provisional constant
  and lands in a code constant + `evals/thresholds/sprint-3.json`.

**`null` is characterisation-only.** The smoke script may pass
`minMatchScore: null` to record the score for every query
regardless of match, but no path that reaches a customer ever
uses `null`. Enforced by having the default be a constant, not
an optional; the smoke is the only caller that overrides it.

The provisional 0.5 is deliberately conservative on the safety
axis: false-`orderable` (system says "we can try to source"
when we actually stock it) is a customer-inconvenience failure;
false-`exact` (system says "in stock" when we don't stock it) is
a promise-breaking failure. Sprint 3 tolerates the first while
sizing the threshold to eliminate the second.

### 4. Entity extraction is a router-side change

`RouterDecision` gains an optional field:

```ts
readonly productQuery?: string;
```

Set when the router (rule OR LLM) can extract a product-string
from the query with reasonable confidence. Absent when the
query is compound, ambiguous, or non-product. Tier 1 dispatch
(from ADR-0014) checks `intent === 'product' &&
productQuery !== undefined` — only that combination fires a
Tier 1 tool call. Tier 2 (missing productQuery on a
product-intent query) falls to the planner-loop path.

Rule-based extraction covers the common shape ("do you sell
X", "how much is X", "do you stock X" — extract the X). LLM
extraction picks up the residual. Both feed the same field.

**Reversal of ADR-0010's stated non-goal.** ADR-0010 originally
listed "Entity extraction" as a non-goal for the router. This
ADR reverses that decision. The reversal is recorded as
Amendment 3 in ADR-0010 itself with its full reasoning, so the
two ADRs don't contradict each other silently. Short version:
Tier 1 dispatch needs a canonical product-string extracted from
the raw query; nothing else in the pipeline has both the query
surface and the intent context to do that; the router is the
natural home. ADR-0004's attribute-schema extraction at ingest
time continues to exist — it's a distinct task.

**Extraction accuracy needs its own metric.** It cannot ride on
`intent_classification_accuracy` — that measures which of six
labels the router picked, not whether it correctly pulled
"Molichaff Hoofkind" out of "do you sell molichaff hoofkind".
This ADR adds **`product_query_extraction_accuracy`** as a new
descriptive metric alongside the existing router metrics.
Applicable iff the golden case has `intent === 'product'` and
carries an expected product-string annotation (a new optional
`expected_product_query` field on the case schema, added
alongside `expected_stock_status` per §7 below). Descriptive-
first, named-floor at Story 4 close-out — same discipline as
ADR-0014's `tool_backed_claim`. Lands in
`evals/thresholds/sprint-3.json` alongside `stock_status_correct`.

**Not load-bearing on confidence for the stock tool's safety
properties.** A wrong extraction degrades gracefully into the
tool's three-state logic: a wrong handle produces no match →
falls through to `unavailable` (if the wrong string happens to
match the out-of-scope list) or `orderable` (otherwise). The
customer copy for `orderable` — "let us try to source that for
you" — is safe under a wrong extraction; a false-positive "in
stock" claim is not producible from a wrong extraction, because
the exact branch requires a match against `minMatchScore` (§3)
and a wrong query won't reach that threshold except by adjacent-
match accident — see §3 for how the threshold defends against
that.

### 5. Structured tool errors, not exceptions

Per ADR-0014's error contract:

- Infrastructure failure (Supabase down, YAML unparseable) →
  the tool throws. GW-26's circuit breaker catches at the
  request boundary.
- `productQuery` empty or exceeds a max length (e.g. 200 chars)
  → return `{ ok: false, error, retryable: false }`. The
  planner sees a structured error and can escalate or retry
  with a different query.
- Retrieval returns zero results — that's a valid tool call,
  not an error. Return `orderable`/`unavailable` per §2.

### 6. Trace span emission

Every invocation emits a `tool-call` span carrying:

- `attributes.name = 'product.stock_lookup'`
- `attributes.args.productQuery` (redacted through the same
  pipeline as chunk citations — no PII from the router)
- `attributes.result.status`
- `attributes.result.matchedChunkIds` (short array, capped
  at 5)
- `attributes.result.outOfScopeReason` when applicable
- `attributes.matchScore` (top-1 hybrid score) — needed for §3
  baseline

Reuses the same `TraceSink` port GW-25 persists to. No new
plumbing.

### 7. Mandatory close-out smoke

Mirrors ADR-0015's mandatory smoke:

- Run the tool against a curated list of 8 golden-case-derived
  queries covering all three shapes and both extraction
  successes and failures. Queries come from the case
  `user_input` field; expected shapes come from the case
  provenance annotation (each case with a `three-state-stock`
  tag has an explicit shape in its comment).
- Verify: (a) hybrid retrieval reaches Supabase (not stubbed),
  (b) each query's returned `status` matches the SME-annotated
  expectation, (c) exact matches carry non-empty
  `matchedChunkIds`, (d) unavailable results carry non-null
  `outOfScopeReason`, (e) the tool call emits a trace span
  landing in the `traces` table with the expected attributes.
- Close-out record the score distribution for §3 threshold
  sizing.

**Producer-ahead-of-consumer risk:** GW-20's result is consumed
by (a) the synthesis step (not yet implemented) and (b) GW-19's
substitute ranking (not yet implemented). Both are Sprint 3
downstream. The mandatory smoke proves the tool's output shape
independently of any consumer, same discipline as ADR-0015.

## What this ADR does not decide

- **How exact/orderable/unavailable is spoken to the customer.**
  Synthesis prompt discipline is a Sprint 3 downstream story
  (post-GW-20). ADR-0014 §"Cases explicitly not solved" already
  named this — cross-tool synthesis is prompt discipline, not
  loop enforcement.
- **Lead-time for orderable.** Currently opaque — the shop
  responds "we can try to source that" without a lead-time
  commitment. Adding a lead-time source is a Sprint 4 candidate.
- **Fuzzy/synonym matching inside retrieval.** ADR-0009 (synonym
  dictionary — case 007 purple/Timothy) is where synonyms are
  addressed. GW-20 gets whatever hybrid retrieval delivers.
- **Substitute ranking.** ADR-0005 owns "when we don't stock X,
  what do we offer instead". GW-19 chains onto this tool's
  non-exact outputs; the chaining logic lives in the loop or the
  planner prompt, not in this tool.
- **The `products` table's future.** Named as a Sprint 4
  candidate. Either populate via ingestion or drop. This ADR
  doesn't commit either way — Story 4 is not the venue for that
  choice.
- **Price answers.** Cases like 002 (shavings price), 007
  (purple horsehage price), 009 (small flake shavings) are
  price-intent, not stock-intent. GW-20 returns a `matchedHandle`
  + chunk IDs; the chunk body carries the variant price table.
  Synthesis reads the price from the chunk; this tool doesn't
  return a price field. Adding a `price_lookup` tool is a Sprint
  4 candidate if the synthesis discipline for reading prices
  from chunks turns out to be too loose.

## Consequences

### In Sprint 3 (this story)

- New adapter: `packages/adapters/src/tool-registry/product-stock-lookup-tool.ts`.
  Implements the ToolRegistry contract for a single tool named
  `product.stock_lookup`. Composed with the retriever adapter
  (already exists) and a small YAML loader for the out-of-scope
  list.
- Router change: `RouterDecision.productQuery` field added.
  Both the rule-based router path and the LLM router path
  populate it when confident. Non-breaking (optional field).
- Out-of-scope data file: `data/nfcs-out-of-scope.yaml`. Seed
  entries derived from golden cases 003, 008, 042. Comments
  reference the case IDs so the provenance is visible.
- Tool wired into the loop via the ToolRegistry adapter. GW-18's
  StubToolRegistry stays as the default until this tool ships;
  after Story 4, the default registry contains `product.stock_lookup`.
- Mandatory close-out smoke script:
  `packages/adapters/scripts/smoke-product-stock-lookup.ts`.
  Same shape as the GW-25 smoke.

### For Sprint 4

- **`products` table cleanup.** Empty, no writer, schema leftover.
  Either populate via ingestion or drop. Named in sprint-log
  Sprint 4 candidates.
- **Lead-time capture for orderable.** Currently opaque. Sprint 4
  candidate — depends on shop giving us that data.
- **`price_lookup` tool** if synthesis discipline for reading
  prices from chunks proves loose. Sprint 4 candidate; measure
  first (Sprint 3 close-out logs price-intent case outcomes).
- **Out-of-scope list evolution.** Adding a new out-of-scope
  category is a data change, not a code change. Sprint 4 might
  add a lightweight admin path if the list grows beyond ~20
  entries.

### Metric added — `stock_status_correct`

Per-case: 1.0 iff `tool_calls[?name=='product.stock_lookup'].result.status`
matches the case's SME-annotated three-state shape. Applicable
iff the case has a `three-state-stock` tag OR is a product-intent
case with an explicit shape in provenance.

**Threshold — descriptive first, named-floor at close-out.**
Sprint 3 measures baseline; close-out sets the floor. Sprint 4
target is `= 1.00` on the golden set — same shape as
`no_prohibited_claims`, this is a safety-adjacent metric.

Not applicable to non-product cases, non-stock product cases
(price-only), or cases without an explicit shape annotation.

### Golden-set schema field — blocker, done before the smoke

Cases 001–049 encode their expected three-state shape in
provenance comments, not in a machine-readable field. The
mandatory smoke (§7) reads the case shape to verify the tool's
output matches the SME expectation. If the smoke reads
provenance-comment text and the later `stock_status_correct`
metric reads a schema field, the two measure different things
and can silently drift.

**So the schema field lands first, before the smoke.**

- New optional field on the case schema:
  `expected_stock_status: Literal['exact', 'orderable',
  'unavailable'] | None`. Applicable to product-intent cases
  where the shop's behaviour has a definite shape; absent for
  cases where the question isn't about stock availability
  (price-only, brand-carry compound queries).
- Same shape as GW-17's shape tags — mirrors an existing
  pattern rather than inventing a new one.
- Cases 001–049 backfilled by reading each case's provenance
  comment and assigning the shape it describes. Ambiguous cases
  (001 Molichaff Hoofkind — provenance doesn't commit to
  exact-vs-orderable) get left as `None` and are captured as an
  SME follow-up.
- **This is a Story 4 sub-task, not a Sprint 4 defer.** The
  smoke depends on it; the metric depends on it. Both run this
  sprint.

Similarly, `expected_product_query: str | None` lands on the
same schema pass, driven by the same reasoning — the metric
introduced in §4 (`product_query_extraction_accuracy`) reads a
schema field. Both fields land together in the same PR.

## References

- ADR-0010 — Intent router (this ADR extends its
  `RouterDecision` shape).
- ADR-0014 — Tool loop (this ADR is the first Tier-1 tool).
- ADR-0015 — Trace persistence (this ADR emits into it).
- ADR-0005 — Substitute ranking (sibling; chains onto this
  tool's non-exact outputs).
- ADR-0013 — Deterministic chunk IDs (this tool returns chunk
  IDs; they must be durable).
- `evals/datasets/README.md` — the three-state stock category
  is defined here.
- Project memory `project_nfcs_customer_signals.md` — captures
  the shop's sourcing behaviour and category boundaries; this
  ADR's out-of-scope list is the machine-readable projection
  of that.
