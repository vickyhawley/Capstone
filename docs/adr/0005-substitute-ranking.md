# ADR-0005 — Substitute ranking: exact / substitute / complement, decision only (Sprint 3 build)

- **Status:** Proposed (2026-09-15, Sprint 1 — decision only; no build
  this sprint. Implementation lands in GW-19, Sprint 3.)
- **Deciders:** Vix Hawley (author), supervisor (approver)
- **Related stories:** GW-19 (substitute ranking build, Sprint 3),
  GW-01 (corpus ingestion — must carry the metadata this ADR relies on),
  ADR-0003 (corpus composition), ADR-0004 (attribute extraction, which
  produces the comparable-attributes surface)
- **Related dataset spec:** `evals/datasets/README.md` §3
  (three-state-stock as a cross-cutting case category)

## Context

Real customer messages sampled from four months of NFCS traffic
(2026-05 through 2026-08) contain a substantive volume of what the
dataset scoping doc calls **three-state stock** exchanges: *"we
don't have it, but we can get it in for you"*. The naive collapse
of that answer to a yes/no ("we don't stock that") loses the sale.
The dataset spec makes three-state-stock a first-class case
category with prohibited-claim guardrails; this ADR is the
retrieval-side counterpart.

Three-state stock actually has *four* substantive answer shapes:

1. **Exact match.** The customer named a product; it's in the
   catalogue; the answer is the product page.
2. **Substitute — held in stock.** The customer named a product;
   it's not in the catalogue *right now*; we hold something
   equivalent. The answer is the equivalent, with a note that it's
   the substitute.
3. **Orderable.** The customer named a product; it's not held; we
   can order it in from the supplier catalogue. The answer names
   the timeline (typically 3–5 working days).
4. **Genuinely unavailable.** The customer named a product; it's
   not held and cannot be sourced. The answer is an abstain with
   a route to human.

Retrieval needs to distinguish these because the ranking depends on
the type. An exact match beats a substitute; a held substitute
beats an orderable one; both beat an outright unavailable. Ranking
by pure semantic similarity conflates them — an exact match and a
substitute look identical in embedding space when the product
descriptions are similar (which is exactly the case for
substitutes).

The general shape of this problem is well-studied in e-commerce
retrieval. The **substitute vs complement** distinction is the
core taxonomy: substitutes are alternative purchases for the same
job (Baileys No 8 ↔ Allen & Page Calm & Condition, both
conditioning feeds); complements are add-on purchases that go
together (rug + tail guard, saddle + numnah). Grouping them into
one retrieval unit loses signal both ways.

## Options considered

### Option A — No distinction; flat retrieval only

Rely on ADR-0001's hybrid retrieval to surface *whatever the
embeddings and lexical index consider closest*, with no
substitute-vs-complement labelling. Let the LLM synthesise the
answer from whatever came back.

- **Pros.** Simplest. No new metadata, no new retrieval path, no
  new ranking logic. Ships fastest.
- **Cons.** The LLM has no signal to say "this is a substitute" —
  it either invents that framing (grounded from nothing) or drops
  it. The three-state-stock case category defined in the dataset
  scoping doc becomes unanswerable at production quality. The bot
  either answers "no" (losing the sale) or hedges without naming
  the substitute clearly. Both fail the dataset's assertion path.

### Option B — Separate substitute-retrieval path

Add a dedicated retrieval endpoint or code path that, given a
non-matching query, runs a second retrieval over "similar-type,
similar-attribute" products explicitly filtered as substitutes.
Two retrieval calls per query when the first misses.

- **Pros.** Clean separation — the substitute path can use
  different ranking parameters, different top-k, different filter
  logic. Each path is testable independently.
- **Cons.** Two calls per query when the first misses is a
  latency cost, and the router has to decide *when* to fire the
  second call. That decision is itself a classifier — which
  becomes a source of failure. Also introduces "which path
  answered?" as observability noise on every trace.

### Option C — Unified retrieval, ranked by relation label

One retrieval call. Every candidate returns with a relation label
in `{exact, substitute, complement, unrelated}`, computed at
query time from a comparison of query and candidate metadata:

- **exact** — the candidate's product handle matches the query's
  named product (via lexical match against
  `chunks.metadata.handle` or a title-fragment match).
- **substitute** — the candidate is the same product type
  (`chunks.metadata.type`) with materially matching attributes on
  the axes the query cared about (e.g. same feeding-rate range,
  same target concern for supplements).
- **complement** — the candidate is a different product type
  known to co-purchase with the query type. Sprint 3 seeds a
  small hand-authored complement graph; a Sprint 4+ story
  learns it from the order-history fixture.
- **unrelated** — everything else. Dropped from the answer path.

Ranking order in the answer: exact > substitute-held > orderable
substitute > complement > (nothing).

- **Pros.** One retrieval call, one router. The relation label is
  a first-class field the LLM prompt can consume ("here is the
  exact match; here is the closest substitute") without needing
  to invent the framing. The label is observable — every trace
  shows what each candidate was labelled as, so misclassifications
  are visible in the eval report rather than opaque.
- **Cons.** The label logic is code that has to be maintained.
  Complement seeding is a small ongoing effort until it's
  learned. Substitute matching depends on the attribute
  extraction quality — a product with no extracted attributes
  can't be labelled a substitute even if it is one.

## Decision

**Adopt Option C — unified retrieval with a relation label per
candidate. Implementation lands in GW-19 (Sprint 3), not this
sprint.**

The purpose of taking this ADR at Sprint 1 is to constrain the
chunk metadata design so it already carries what GW-19 will need,
and no re-ingest is required at Sprint 3.

### Chunk metadata requirements (must be present before GW-19)

Every product chunk's metadata must carry, at minimum:

- `handle` — for exact-match detection. **Already stored** by
  ADR-0003 / GW-01 commit (a).
- `type` — the catalogue's product type. Used to filter
  substitute candidates to the same type. **Already stored** by
  ADR-0003 / GW-01 commit (a).
- `vendor` — used as a secondary substitute signal (same vendor
  is a stronger substitute than cross-vendor). **Already stored**
  by ADR-0003 / GW-01 commit (a).
- `extracted_attributes` — the ADR-0004 output. Substitute
  ranking uses the type-specific comparable attributes (feeding
  rate for Feed, waterproof rating for Outdoor Rugs, etc.) to
  compute an attribute-distance score between query and
  candidate. **Stored** by ADR-0004 / GW-01 commit (b).

**Gap check.** Every field the substitute-ranker needs is either
already stored by GW-01 or lands as part of ADR-0004's extraction.
No new fields need to be added, no re-ingest required at Sprint 3.

If a Sprint 2 refinement of ADR-0004 changes the schema shape
(e.g. adds a `dimensions` attribute for saddles), the schema
version bump forces a re-extract for that type — that's the
existing ADR-0004 mechanism, not a substitute-ranking concern.

### Sprint 3 implementation shape (informational — locks nothing)

GW-19 will add:

- A `label_relation(query_metadata, candidate_metadata)` function
  returning `'exact' | 'substitute' | 'complement' | 'unrelated'`.
- A hand-authored complement graph, seeded from staff knowledge
  and the synthetic order fixtures' basket co-occurrence.
- A rerank stage (or a post-retrieval ordering pass) that sorts
  by relation label then by relevance score.
- Prompt changes that give the LLM the relation label per cited
  chunk so it can compose "we hold X (exact); the closest
  alternative we do stock is Y (substitute)" answers.
- Eval cases in the golden set targeting each of the four answer
  shapes above.

None of this is committed by this ADR — GW-19 gets its own design
pass. The commitment here is only that Sprint 1's chunk metadata
supports the eventual build.

## Prior work

- **McAuley, Pandey, Leskovec (2015), "Inferring Networks of
  Substitutable and Complementary Products", KDD.** Foundational
  paper on the substitute/complement taxonomy in product retrieval.
  Uses co-view and co-purchase signals to infer relationships;
  Sprint 4+ could adopt that approach once real traffic exists.
- **He, McAuley (2016), "VBPR: Visual Bayesian Personalized
  Ranking".** Related work on image-based substitute detection.
  Groundwork does not use product images; noted here for
  completeness.
- **Amazon, eBay, and Shopify's own product search** distinguish
  exact-match from substitute-match at ranking time. This is
  established practice, not an invention.

**What Groundwork does differently.** Small-catalogue,
single-shop, ~400 products. The McAuley approach needs
co-view/co-purchase data at scale; NFCS doesn't have enough
traffic yet for that signal to be reliable, so Sprint 3 uses a
hand-authored complement graph plus attribute-distance
substitute detection. When real traffic accumulates, a Sprint
4+ story can add learned relationships as a follow-on.

## Consequences

**Positive.**

- Three-state-stock case category becomes answerable at
  production quality — the bot can say "we don't hold X but
  hold Y as the equivalent" with grounded relation labels.
- Substitute detection uses attributes ADR-0004 already
  extracts; no re-ingest at Sprint 3.
- The relation-label observability makes misclassifications
  measurable in the eval harness (per-label recall / precision)
  rather than opaque.
- The complement graph starts hand-authored — cheap, honest —
  and can be replaced with a learned graph when traffic exists.

**Negative.**

- Sprint 3 build risk: substitute-ranker quality depends on
  attribute-extraction quality (ADR-0004's colour-agreement
  gate). If extraction ships below threshold and can't be
  fixed, substitute ranking is starved of signal. The ADR-0004
  shipping gate is the correct forcing function.
- The hand-authored complement graph needs staff-time input.
  Small (~50 pairs to start; a rug goes with a tail guard, a
  saddle with a numnah, etc.). Not built this sprint.

**Reversibility.** High. The relation label is computed at
query time from metadata that already exists; if the labelling
turns out to be worse than pure semantic ranking, the fallback
is a one-line change (return `'unrelated'` unconditionally).
No schema change to undo.

## Follow-ups

- GW-19 (Sprint 3) — implements the labelling and ranking.
- Hand-authored complement graph (Sprint 3, small subtask of
  GW-19) — the ~50 initial pairs.
- Sprint 4+ candidate — learn substitute/complement
  relationships from real order history using the McAuley
  approach, replacing the hand-authored complement graph.
- Golden case additions (Sprint 2) — four cases per product
  type covering the four answer shapes (exact, substitute-held,
  orderable, unavailable). Coordinated with the SME.
- Metrics addition (Sprint 3) — per-relation-label recall /
  precision on the golden set. Landing alongside GW-19.

---

## Addendum — substitute pattern observed in real traffic (2026-09-15)

The `substitute-offered` pattern this ADR anticipated is present
in real customer DMs: golden case `product-022-haygates-conditioning-cubes`
asks after Haygates conditioning cubes (not held); the shop's
actual reply recommended HiLight conditioning cubes at £13 as the
in-stock equivalent. The pattern is no longer theoretical for
Sprint 1 — it is a measured retrieval requirement, and the tag
`substitute-offered` is defined in `evals/datasets/README.md` §3.
GW-19 implementation lands in Sprint 3 as this ADR describes;
until then, substitute-offered cases exercise the retriever's
ability to surface the equivalent alongside the queried item.
