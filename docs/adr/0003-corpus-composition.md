# ADR-0003 — Corpus composition: product records and prose guides as two document types

- **Status:** Proposed (2026-09-14, Sprint 1 prep — pending sign-off before GW-01 ingestion lands)
- **Deciders:** Vix Hawley (author), supervisor (approver)
- **Related stories:** GW-01 (ingestion), GW-21 (delivery-zone tool),
  ADR-0001 (retrieval strategy, defines the chunks table this decision
  populates)

## Context

The obvious first corpus is the product catalogue — it exists, it's
clean, the export is 398 products / 1,454 variant rows sitting in
`data/catalogue/products.csv`. If the catalogue answered the questions
customers actually ask, single-source ingestion would be the right
plan.

It doesn't. Descriptions are substantial (median 447 chars, zero
empty) but they are **marketing copy, not spec sheets**. The facts
that come up in real customer messages — fit, feeding rates, weather
performance, feed composition — are mostly absent from the catalogue
body, and the structured metafields Shopify offers as an alternative
carrier are barely populated.

That's a corpus-composition problem, not a retrieval problem. No
amount of rerank cleverness pulls a fact out of text that doesn't
contain it. If the ingestion path treats the catalogue as the whole
corpus, the answer engine's ceiling on fit and feeding questions is
low regardless of how well ADR-0001's hybrid retrieval works.

## Evidence

Measured by `scripts/profile_catalogue.py`. Rerun any time the
catalogue refreshes; the patterns are readable in the script and the
numbers below are what that probe returns against the committed CSV.

**Shape of the catalogue.**

- 398 products, 1,454 variant rows (Shopify export format: one product
  row followed by variant-only rows, deduplicated to one row per
  handle).
- Description length: median 447 characters, zero products with an
  empty description.

**Fact-type coverage** — fraction of products whose title, tags, or
description mention the fact type at all. Reported as a range from
a **tight** pattern set (only the unambiguous cases — "feeding rate",
"guaranteed analysis") to a **broad** pattern set (adds looser
mentions — "recommended daily amount", "contains oats and barley").
Both pattern sets are committed to `scripts/profile_catalogue.py`
under the `TIGHT` and `BROAD` dicts, so any reader can inspect
exactly what counts as a match:

| fact type          | tight       | broad        | pattern-sensitive? |
| ------------------ | ----------: | -----------: | ------------------ |
| size guidance      | 3 (0.8%)    | 16 (4.0%)    | yes                |
| feeding rate       | 4 (1.0%)    | 12 (3.0%)    | yes                |
| waterproof rating  | 26 (6.5%)   | 27 (6.8%)    | no (~7%)           |
| ingredients        | 25 (6.3%)   | 135 (33.9%)  | very               |

Reading the ranges: **size** and **feeding** never rise above ~4% and
~3% even with the broadest reasonable pattern set. **Waterproof** is
pattern-insensitive at ~7% — that number is what it is. **Ingredients**
is the most pattern-sensitive metric in the catalogue, spanning
6–34%; even the broad ceiling leaves two products in three without
ingredient information a retriever could cite.

An independent probe by the SME during pre-handover profiling landed
in the same ballpark (size ≈ 4%, feed ≈ 5%, waterproof ≈ 7%,
ingredients ≈ 23%) with a pattern set I don't have access to. Feed's
5% sits slightly above the broad ceiling here, and ingredients' 23%
sits within the range — both consistent with a somewhat different
strictness balance. The important point is that no reading of the
data puts fit or feeding coverage anywhere near sufficient.

**Structured metafields.** Shopify supports typed product metafields
that a bot could read directly without a language-based probe. Best
populated is `Color` at 109 of 398 products (27.4%); the next tier is
`Animal feed form` at 14%, then everything drops to single digits.
None of the fit- or feeding-relevant metafields (size chart, feeding
rate, waterproof mm, ingredient list) is populated on more than 6% of
the catalogue.

## Probe methodology

`scripts/profile_catalogue.py`. The script:

1. Loads `data/catalogue/products.csv` (Shopify variant export
   format).
2. Deduplicates to one row per `Handle` — takes the first row whose
   `Title` is non-empty, which is the product-level row.
3. For each fact type, defines **two** case-insensitive regex pattern
   sets: `TIGHT` (only unambiguous mentions — "feeding rate",
   "guaranteed analysis") and `BROAD` (adds looser mentions —
   "recommended daily amount", "contains oats and barley"). The
   patterns are keyed on the terminology real customer messages use.
4. Counts a product as *covering* a fact type if any of the pattern
   set's patterns matches anywhere in the concatenated title, tags,
   and description body. Both sets are run against every product.
5. Reports coverage side-by-side as `N (X%)` for tight and broad, so
   pattern-sensitive metrics show as a range and pattern-insensitive
   ones show as a stable point. Also reports populated metafield
   columns ranked by count.

Rerun with `python3 scripts/profile_catalogue.py`. Adjust either the
`TIGHT` or `BROAD` dict at the top of the script to tune what counts
as "tight" vs "broad"; the shape of the finding is stable, only the
exact endpoints of the range move.

## Options considered

### Option A — Catalogue only

Ingest the 398 products as-is, one chunk per product (or per
variant), rely on retrieval over descriptions.

- **Pros.** One document type, one chunker, one migration. Ships fast.
- **Cons.** Locks in the coverage ceiling above. Fit and feeding
  answers either abstain, hallucinate, or cite a chunk that doesn't
  actually contain the fact. The last of those is the worst — it
  looks like grounded answering to the eval and to the customer,
  while being fundamentally wrong. This is not a defect the retrieval
  layer can compensate for.

### Option B — Catalogue plus prose guides, two document types

Ingest the 398 products *and* a second body of content: sizing
guides, feeding guides, care guides. Different chunking strategy per
document type (product records get whole-product chunks; guides get
semantic chunks with overlap). Same chunks table, one column
distinguishes them.

- **Pros.** Facts that don't fit into a product listing (a rug fit
  guide covers many products at once; a general feeding-rate guide
  applies to a whole feed brand) land where they naturally live. The
  retriever can pull a product record and a matching guide chunk into
  the same answer, cite both, and the answer is genuinely grounded.
- **Cons.** Two chunkers to build and maintain. The guides don't
  exist yet — the ingestion path is a promise until a real guide
  lands. Also introduces a `document_type` filter to the query layer,
  which interacts with the F2 over-fetch-then-filter strategy in
  ADR-0001 (may raise the frequency at which the full-scan fallback
  fires).

### Option C — Catalogue plus enriched metafields

Keep the catalogue as the sole corpus but invest in populating the
structured metafields (fit tables, feeding rates, waterproof mm) on
every relevant product. Retrieval reads metafields directly, no
prose needed.

- **Pros.** Fully structured, cheapest to query, no chunking of
  guides. The typed values are easy to display in the answer without
  extraction failures.
- **Cons.** This is a data-entry project, not an engineering
  decision. Sprint budget doesn't cover backfilling ~370 products'
  worth of missing metafields, and even if it did, the shape of the
  answer to *"how do I fit a saddle to a wide-jawed cob?"* isn't a
  metafield lookup — it's prose reasoning over a guide. Option C
  addresses only the tabular-fact subset of the problem.

## Decision

**Adopt Option B — two document types in the same chunks table.**

Concretely:

1. **Product records.** One chunk per product (not per variant),
   composed from title / vendor / type / tags / description / a
   rendered variant table (option name, value, price). Variant-level
   detail lives *inside* the product chunk rather than sprawling into
   many near-duplicate chunks. Chunk metadata carries `handle`,
   `vendor`, `type`, `price_range`, and the `local_delivery_only`
   flag (which is load-bearing for GW-21; see ADR-0001's F2 filter
   discussion for how metadata filters interact with the HNSW index).

2. **Guides.** Prose, chunked semantically with overlap. Different
   parameters from product records — guides are longer, coherent
   text where overlap prevents fact-splitting across chunk
   boundaries. None exist yet; GW-01 builds the ingestion path and
   ships one or two fixture guides so the code path has coverage,
   with real guide content authored separately later.

3. Both land in the **same chunks table**, distinguished by a
   `document_type` column (values: `product`, `guide`). Retrieval
   can filter to one type, blend both, or apply per-type weighting
   in the fusion layer. That composition is a query-layer concern
   and out of scope for this ADR.

Adopting Option B is the honest decision even though guides don't
exist yet: it says the corpus needs a second body of content, sets
the shape of the ingestion path to accept it, and stops the
retrieval work from being built on a coverage ceiling that would
have to be renegotiated later.

## Consequences

**Positive.**

- The corpus can grow into fit and feeding answers as guides are
  authored, without a re-ingest of the catalogue.
- Product chunks are compact (one per product), so a "did we retrieve
  the right *product*?" question has a clean unit to count.
- The `document_type` discriminator lets retrieval, evaluation, and
  the runner all slice by content class from day one.

**Negative.**

- Two chunkers to build, test, and keep in sync as the schema
  evolves. Mitigated by both writing to the same `chunks` schema.
- Adds a filter dimension (`document_type`) that must be considered
  every time query-layer changes land. The F2 strategy from
  ADR-0001 handles this, but the fallback counter should be
  monitored per-`document_type` slice as well as overall.
- The Sprint 1 corpus will be product-heavy until guides catch up;
  fit-question metrics will look bad until the guide side of the
  corpus is populated. This should be visible in the eval report,
  not hidden — recall@k sliced by intent will show fit and welfare
  weakness plainly.

**Reversibility.** High. The `document_type` column can be added or
dropped in a migration; a single-type corpus is a strict subset of a
multi-type one. If guides never materialise, the system degrades
gracefully to a catalogue-only retriever with an unused enum value.

## Follow-ups

- GW-01 (ingestion) — implements this ADR's two-chunker design. The
  ADR must be signed off before that story starts.
- ADR-0004 (attribute extraction at ingest) — LLM extraction with
  source-span grounding. Amends GW-01. The chunk metadata designed
  here (handle / vendor / type / price range / local_delivery_only)
  expands to include typed extracted attributes with confidence and
  source spans once ADR-0004 lands.
- ADR-0005 (substitute ranking) — decision only for Sprint 1, build
  in GW-19 (Sprint 3). Constrains what chunk metadata must carry.
- ADR-0006 (chunking strategy) — target size, overlap, hierarchical
  parent chunk. GW-01 ingestion ships with tunable placeholder
  parameters (guide chunker: target ~800 chars, overlap ~100 chars)
  pending this ADR.
- ADR-0007 (retrieval query filters) — content_type / active / brand /
  `document_type` taxonomy and how those map onto ADR-0001's F2
  strategy. `document_type` is introduced by this ADR (0003).
- Fixture guides — GW-01 needs one or two prose guides to exercise
  the guide chunker end to end. Authored separately by the SME; a
  minimal fixture guide (e.g. "How to size a rug") is enough to
  prove the pipeline.
- Rerun `scripts/profile_catalogue.py` after any catalogue refresh,
  and if fact coverage moves materially — say, ingredients climbs
  above 60% because a supplier bulk-imports composition — revisit
  the balance between catalogue and guides.

---

## Addendum — post-extraction confirmation (2026-09-15)

`pnpm coverage` (see `packages/ingestion/src/coverage-cli.ts`)
measures the same kind of coverage as `profile_catalogue.py` but
against the post-extraction chunks in Supabase, per attribute key
per product type. The result confirms this ADR's premise sharply:

- **Feed** (n = 90, largest and most trustworthy sample):
  `feeding_rate_g_per_100kg_per_day` is populated on **1 of 90
  products (1.1%)**. Not the extractor being conservative — the
  fact is absent from the descriptions. Compare
  `profile_catalogue.py`'s tight/broad range of 1.0–3.0% for
  feeding-rate mentions in raw prose; the extractor's number
  sits inside that range, so extraction did not close the gap
  because there is nothing in the source to extract.
- **Outdoor Rugs** (n = 2, sample too small):
  `waterproof_mm` 0%, `breathability` 0%. The Equidry Aura
  description that motivated this ADR IS in the catalogue but
  under type `Equestrian Clothing`, which has no schema this
  sprint — a Sprint 2 candidate.

**Where extraction is worth its cost** — the addressable-fact
axes that ARE in prose but were not structured before:

- Feed: `form` 91.1%, `species` 78.9%
- Supplements: `form` 100%, `target_concern` 92.9%, `active_ingredients` 64.3%
- Bedding: `material` 100%
- Haylage: `cut_type` 100%

Retrieval-time filters on these attributes are newly viable and
weren't before this sprint. That's the corpus-composition win
ADR-0003 argued for: the two-document-types plan doesn't rely on
extraction rescuing sparse prose — extraction lifts what's there,
and the prose guides carry the facts that aren't (feeding rates,
fit rules, waterproof ratings).

Full per-attribute breakdown lives in ADR-0004's addendum.

---

## Second addendum — findings from golden-case source-ID authoring (2026-09-15)

Populating `required_source_ids` on the 40-case Sprint 1 golden
dataset surfaced three findings that were latent in this ADR's
argument but only became concrete when real cases had to be
grounded against real chunks.

### The guide gap is measurable and specific

Fifteen of the 40 golden cases have no corpus chunk to point at.
That number splits cleanly:

- **Nine cases where the catalogue legitimately doesn't have the
  answer** (three-state negatives, brand-not-stocked, orderable
  positives, absent variants). `[]` is honest; the corpus has
  nothing to say and the assistant scores by not fabricating.
  See §1 of `evals/datasets/README.md` for the case-schema
  addition covering this shape.
- **Three fit cases that the catalogue can't answer at all**
  (saddle fitting for a wide-backed cob, saddle fitting probed
  by a prompt injection, girth-line fitting for a dressage
  horse). Product listings for saddles and girths carry
  dimensions and prices, not the fit rules a customer would
  need to hear.

The fit gap is exactly the coverage ceiling this ADR named. Now
it has cases attached — three of the four fit boundary probes in
the dataset can't be sourced without new guide content.

### Sprint 2 candidates — guides to close the fit gap

Two guides would close the fit-question gap and give
`required_source_ids` real chunks to point at:

- **`data/guides/saddle-fitting.md`** — general saddle-fitting
  principles (tree width, gullet clearance, panel style),
  when to route to a professional fitter, what a customer can
  and can't judge visually. Covers cases 026 and 030.
- **`data/guides/girth-fitting.md`** — girth-line depth, girth
  length across saddle sizes, girth types (dressage, GP,
  short, long). Covers case 027.

Neither guide exists today; both are Sprint 2 candidates. Landing
them means re-running `required_source_ids` on the affected cases
and shifting them from `[]` to real chunk IDs.

### The negative-source finding — corpus has no positive representation of absence

The nine legitimately-empty cases expose a subtler pattern this
ADR didn't anticipate. When the honest answer is "no, we don't
stock wormers", nothing in the corpus supports that claim
directly. The assistant answers correctly by *failing* to
retrieve a positive match. That's a fragile shape:

- If the retriever happens to surface a superficially-relevant
  chunk (a bedding product that mentions "wormers" as a
  contraindication, a supplement whose description says "no
  known interactions with wormers"), the assistant may treat
  the presence of the word as license to answer positively.
- The evaluation harness can't distinguish "the assistant
  correctly refused because no positive chunk was returned"
  from "the assistant refused because retrieval failed for
  unrelated reasons".

A **"what we don't stock" guide** would turn each canonical
negative into a positive chunk the retriever can cite. Sprint 2
candidate. Structure: a policy-shaped guide listing categories
the shop does not carry and does not source (wormers, electric
fencing, prescription medications, tack repair services), with
one paragraph per category naming the correct routing
("wormers: nearest local vet is X"). The retriever hits
positive text; the assistant grounds the "no" instead of
guessing it.

### Follow-up story shape

All three sprint-2 guide-authoring items share the same shape:

1. SME (or shop owner) drafts the guide content.
2. Guide lands under `data/guides/*.md`.
3. `pnpm ingest` refreshes the corpus.
4. `evals/scripts/find_chunks.py` surfaces the new chunk IDs.
5. Affected golden cases have their `required_source_ids`
   populated from `[]` to real chunks.
6. Metrics that were previously N/A on those cases (recall_at_k,
   retrieval_relevance) begin scoring.

That fifth step is exactly why the case-schema addition in
`evals/datasets/README.md` §1 (legitimacy of `[]` on answer
cases) is important: without it, populating a `[]` later would
look like "fixing the case" rather than "the corpus grew to
support what the case was already correctly claiming".
