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
- ADR-0004 (query filters) — the retrieval-query-filters ADR listed
  as a follow-up on ADR-0001 slides from the reserved-0003 slot to
  0004. `document_type` is one of the filters it will define.
- Fixture guides — GW-01 needs one or two prose guides to exercise
  the guide chunker end to end. Authored separately by the SME; a
  minimal fixture guide (e.g. "How to size a rug") is enough to
  prove the pipeline.
- Rerun `scripts/profile_catalogue.py` after any catalogue refresh,
  and if fact coverage moves materially — say, ingredients climbs
  above 60% because a supplier bulk-imports composition — revisit
  the balance between catalogue and guides.
