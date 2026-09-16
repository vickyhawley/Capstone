# ADR-0001: Retrieval strategy — hybrid dense + sparse, fusion and rerank deferred to Sprint 1 experiment

- Status: **Proposed** (fusion method and reranker deferred pending Sprint 1 measurement; other decisions ratified)
- Date: 2026-09-13 (Sprint 0), revised for Sprint 1 prep
- Deciders: Vix Hawley (author), supervisor (approver)
- Related stories: retrieval spike, groundedness eval, Sprint 1 rerank/fusion experiment

## Context

Groundwork answers product, fit and logistics questions from a cited
knowledge base of unstructured content (product descriptions, fit guides,
policy pages, supplier PDFs). Every factual claim in an answer must bind
to a retrieved source; claims without a source are dropped, never
invented. The retrieval stage is therefore load-bearing: if it doesn't
return the right chunk, the answer either won't ground or will be
refused, both of which degrade the correct-abstention / false-refusal
metrics that the project is graded on.

Two properties of the domain shape the choice:

1. **Queries mix intent classes.** "What size cob rug for a 15hh
   Connemara?" is semantic and comparative. "Do you deliver to IV postcodes
   next-day?" is nearly a keyword lookup against a policy page. A single
   retrieval strategy must handle both without a routing layer above it, or
   the router itself becomes a source of failure.

2. **Corpus scale is small but growing.** Sprint 1 will seed ~500-1000
   products and ~5k chunks. The design target is ~10k products / ~50k
   chunks by the end of the project. Both are well within pgvector's
   capable range with HNSW, but the seed is small enough that lexical
   retrieval alone will look competitive on a shallow benchmark — a real
   risk to a naive comparison, because dense's advantage over sparse widens
   as corpus and query diversity grow.

Storage is Supabase (chosen prior to this ADR; pgvector already available).
The question here is only about how to _query_ it.

## Options considered (retrieval strategy)

### Option A — Dense only (pgvector + HNSW)

Embed every chunk, index with HNSW, cosine similarity at query time.

- **Pros:** simplest; one index; handles paraphrase and semantic queries
  well; no query pre-processing.
- **Cons:** weak on exact-string queries (SKUs, postcodes, brand names);
  known to underperform lexical on short factual lookups; behaviour is
  opaque when it fails (nothing to grep).

### Option B — Sparse only (Postgres full-text search)

`to_tsvector('english', text)` with a GIN index; `ts_rank` at query time.

- **Pros:** boring, well-understood, cheap; exact-string queries just work;
  no embedding model to keep in sync with the corpus; failure modes are
  legible ("this term wasn't in the index").
- **Cons:** poor on paraphrase and synonym-heavy queries; requires
  stemming/synonym tuning to catch equine-specific jargon (cob/pony/native,
  numnah/saddle-pad); doesn't degrade gracefully — either the term matches
  or it doesn't.

### Option C — Hybrid: dense + sparse fused, no reranker

Run both A and B in parallel, fuse the two ranked lists (see "Fusion
method" below), take top-k of the fused list.

- **Pros:** captures both intent classes without a router; both indexes
  live in Postgres, so one system, one migration; each side's failure is
  compensated for by the other.
- **Cons:** two queries per request; fusion mechanics are one more thing to
  tune; the fused ordering can still place a strong-lexical, weak-semantic
  match above a strong-semantic, weak-lexical one when the latter is more
  relevant.

### Option D — Hybrid + reranker (cross-encoder or managed)

C plus a rerank stage over the top-N fused candidates using either a
managed service (Cohere Rerank) or a self-hosted cross-encoder (bge-reranker
family).

- **Pros:** cross-encoders are consistently the strongest re-ranking signal
  in published benchmarks; often turns marginal retrieval quality into
  answer-quality wins downstream; single knob to trade recall for precision.
- **Cons:** adds latency (100-300 ms typical for managed, more for
  self-hosted on function cold start); adds cost (per-query for managed, or
  a large deploy for self-hosted); adds a vendor dependency (Cohere) or a
  much heavier function package (self-hosted). None of these are prohibitive,
  but none are free — and the win depends on retrieval quality being _the
  bottleneck_ in the first place, which we haven't measured.

## Decision

**Adopt Option C (hybrid dense + sparse) for Sprint 1.**

**Defer both the fusion method and the reranker decision to a Sprint 1
experiment.** A `Reranker` port exists in `packages/core` with a
`NoopReranker` in `packages/adapters` as the scaffold default and as the
control condition in the experiment. Fusion strategies are compared in
the same experiment (see "Sprint 1 experiment" below).

Both dense and sparse indexes are added in migration 001 so the corpus is
indexed once, not twice, and switching fusion or rerank strategies in
Sprint 1 doesn't require re-ingest.

## Sparse index specifics

The sparse index is a Postgres tsvector, generated as a stored column on
`chunks`:

```sql
content_tsv tsvector generated always as (to_tsvector('english', text)) stored
```

with a `GIN(content_tsv)` index. Ranking at query time uses `ts_rank` (or
`ts_rank_cd` — the coverage-density variant weights term proximity more
heavily; both are candidates for the fusion experiment).

**This is not BM25.** BM25 is a term-frequency / inverse-document-frequency
ranking function with tunable saturation (`k1`) and length-normalisation
(`b`) parameters; `ts_rank` is a simpler formula weighted by lexeme
positions. If we later find `ts_rank` is the bottleneck, upgrade paths
are (i) install `pg_search` (ParadeDB's BM25 extension for Postgres),
(ii) build a custom ranking SQL function, or (iii) move sparse retrieval
off Postgres. All three are non-trivial and would earn their own ADR.

The equine domain has enough jargon (cob/pony/native, numnah, girth,
gullet) that we'll want a custom synonym dictionary once Sprint 1 has
real query traffic. That's ADR-0005 territory — not now.

## Embedding model

**Commit: OpenAI `text-embedding-3-small` at 1536 dimensions.** The
migration 001 `vector(1536)` column reflects this.

Reasoning:

- Strong retrieval quality per dollar on MTEB benchmarks — competitive
  with 3-large for most classification and retrieval tasks at ~1/6 the
  cost and 1/3 the storage.
- Supports Matryoshka truncation: the same embeddings can be truncated
  to 512 or 256 dimensions without a re-embed if we ever need cheaper
  storage or faster HNSW. That means the 1536 pick doesn't lock out
  future optimisation, only future _model_ swaps.
- OpenAI is already in the LLM adapter's provider set, so no additional
  vendor onboarding.

Alternatives that would earn their own ADR if adopted:

- `voyage-3-lite` (1024 dims) — reported slightly better on retail
  retrieval benchmarks; separate vendor.
- `bge-small-en-v1.5` (384 dims) — self-hosted, no per-query cost;
  requires model-serving infra we don't have.

### Migration cost of changing embedder later

Changing embedding model requires:

1. Add `vector(N)` column (new name) in a new migration.
2. Re-embed every chunk. At OpenAI's current pricing this is ~$0.02
   per 1M input tokens; ~50k chunks × ~200 tokens each ≈ 10M tokens
   ≈ $0.20. Cheap. Time cost is ~10 minutes at OpenAI rate limits.
3. Rebuild the HNSW index on the new column.
4. Dual-write briefly to allow rollback, then drop the old column.
5. Update any code holding a literal `1536` (currently: the migration
   only; the adapter reads the dim from the model client).

This is not paralysing. The choice can be revisited in Sprint 3+ if
Sprint 1 shows embedding quality is the bottleneck — but it is a
migration and a re-embed, not a config change. The purpose of this
section is to make that visible before someone assumes otherwise.

## Filtered retrieval strategy

pgvector's HNSW index performs approximate nearest-neighbour search over
vectors, then applies any `WHERE` clause as a **post-scan filter**. This
means a query like `where category = 'saddle' order by embedding <=> $1
limit 10` can silently return fewer than 10 rows if the top-10 HNSW hits
happen to include only 4 saddles. Recall visibly degrades as the filter
gets more selective, and there's no error — the query just returns a
shorter list.

Groundwork will filter often: by `documents.content_type` (drop policy
chunks when the intent is product), by `products.active` and `stock`
(never surface out-of-stock lines), and increasingly by category as
Sprint 2 refines routing.

Three strategies considered:

### F1 — Partial indexes

One HNSW per popular filter (e.g. `where active = true`, one per category).

- **Pros:** filter matches an index → same performance as unfiltered.
- **Cons:** combinatorial. Two boolean filters × twenty categories × ten
  brands is 400 partial indexes, each rebuilding on ingest. Even a
  restrained set (active × category = 40) is heavy write-amplification
  for a corpus still under active ingest. And it doesn't help ad-hoc
  filter combinations.

### F2 — Over-fetch then filter

Retrieve top-Nk (N = 4 by default) via HNSW, apply structured filters as
a SQL `WHERE` on the joined tables, take top-k of what remains. If fewer
than k rows survive, degrade to a full sequential scan with the same
`WHERE`.

- **Pros:** one index handles arbitrary filter combinations; no
  combinatorial explosion; the fallback is bounded — at 50k chunks a
  sequential scan is <100 ms.
- **Cons:** recall degrades on highly selective filters (a 4× over-fetch
  may not be enough); the fallback fires more often than we'd like as
  the corpus grows. Both are measurable, so we'll know.

### F3 — Filters in the fusion layer

Dense side runs unfiltered; sparse side does the `WHERE`; fusion takes
the intersection.

- **Pros:** dense side keeps its full HNSW recall.
- **Cons:** doesn't actually help — the fused output only contains chunks
  that appear in both lists after the sparse filter, so a strong semantic
  match filtered out sparse-side is invisible to the fusion. Also
  couples the fusion layer to filter semantics, which is exactly the
  wrong place.

### Decision — F2 with a full-scan fallback

Chosen because:

- Partial indexes (F1) are a premature optimisation. We don't yet know
  the filter distribution; committing to it hardens a guess into schema.
- Fusion-side filtering (F3) doesn't fix the dense-side recall problem
  we actually have.
- F2's failure mode (recall degradation on highly selective filters) is
  bounded by the fallback and directly observable: the runner should
  record `filter_fallback_fired` per query, so we can measure how often
  it happens and revisit if it's frequent.

Migration 001 adds a GIN index on `chunks.metadata` (`jsonb_path_ops`) to
make the `WHERE` cheap for the general JSONB case. Structured filters
that live on `products` and `documents` reuse those tables' existing
indexes via join.

Sprint 1 will benchmark: (a) recall@k under filters of increasing
selectivity, (b) how often the fallback fires on the golden set. If
selectivity ≥ 90% queries force the fallback, we revisit — likely toward
F1 for the two or three highest-cardinality filters only.

## Sprint 1 experiment (definition of the deferred decisions)

**Question:** what combination of fusion method and reranker produces
the best end-to-end answer quality at acceptable latency and cost?

**Design.** A 2 × 3 grid, all six conditions run against the identical
retrieval candidates so variance comes only from the fusion + rerank
stages.

|                          | NoopReranker (control) | Cohere Rerank v3 | bge-reranker-base |
|--------------------------|------------------------|------------------|-------------------|
| **RRF (k=60)**           | R1                     | R2               | R3                |
| **Weighted score norm**  | R4                     | R5               | R6                |

- RRF: Reciprocal Rank Fusion with the standard `k=60` smoothing constant.
- Weighted score norm: min-max normalise dense and sparse scores into
  [0,1], then combine with a tuned weight (`0.5 · dense + 0.5 · sparse`
  as the starting point; the experiment tunes on a held-out slice).

Fusion and rerank interact: a fusion strategy that produces a
well-calibrated ordering benefits less from reranking than one that
doesn't. Testing rerank alone would give a misleading answer.

**Metrics (higher is better unless noted).**

- Retrieval: recall@10, nDCG@10 against a golden query set (target: 75
  labelled queries by end of Sprint 1).
- Answer quality: groundedness (fraction of claims with binding
  citations) and answer-relevance on the same set.
- Refusal: correct-abstention rate and (lower is better) false-refusal
  rate on the safety set.
- Ops: p50 / p95 additional latency; per-query cost.

**Stopping rules.**

- Fusion: pick the fusion method with the higher recall@10 on the
  golden set, provided the gap is ≥3 absolute points; otherwise default
  to RRF (fewer parameters, one less thing to tune).
- Reranker: ship a reranker iff it improves recall@10 by ≥5 absolute
  points AND improves groundedness by ≥3 absolute points AND costs less
  than 300 ms p95 additional latency. If only one metric clears, ship
  the noop and re-open in Sprint 2.

**Result artefact.** Committed to `evals/results/sprint-1/fusion-rerank.md`
and the outcome recorded as an addendum on this ADR.

## HNSW parameter sizing

HNSW is configured (see migration 001) for the ~50k-chunk design target,
not the ~5k seed. Rationale: index rebuilds during ingest churn are the
main risk, and sizing for the eventual corpus means Sprint 1's early
benchmarks are representative of steady-state behaviour rather than of a
too-small index that happens to look fast. Parameters chosen: `m = 16`,
`ef_construction = 64` — pgvector defaults known to be adequate at this
scale. Sprint 1 will benchmark recall@k across `ef_search` values 40 /
80 / 160 before committing to a query-time setting.

## Consequences

**Positive.**

- One retrieval implementation covers both intent classes without a
  routing layer.
- Both indexes live in Postgres; no second data system.
- The `Reranker` port lets the rerank decision be a compositional swap,
  not a rewrite. Fusion is code, not schema, so the same holds there.
- Cost stays near zero until the Sprint 1 experiment justifies otherwise.
- Filter strategy has an observable failure mode (fallback counter) and
  a bounded worst case (<100 ms).

**Negative.**

- Two queries per request instead of one. Acceptable on the design
  corpus; if that changes materially, revisit.
- `ts_rank` is weaker than BM25 on some query shapes. If Sprint 1
  benchmarks show sparse quality is the bottleneck, we spend an ADR on
  BM25 via `pg_search` or move sparse off Postgres.
- Filter fallback may fire often as the corpus grows and filters get
  more selective. Instrumentation is in place from day one so we'll
  know.

**Reversibility.** High. Fusion strategy is code, not schema. Rerank
addition is code, not schema. Filter strategy is code and one JSONB
index. Only a change in embedding model requires a re-embed — and even
that costs ~$0.20 at current scale.

## Follow-ups

- ADR-0002: iteration-vs-timeout budget sizing (**already landed** — this
  ADR's original follow-up list assumed 0002 was chunking strategy, but
  0002 was taken by the iteration/timeout decision during Sprint 0 prep).
- ADR-0003: **corpus composition** — two document types (product records
  + prose guides). Landed 2026-09-14. Originally reserved for retrieval
  query filters; that topic has slid down further, see below.
- ADR-0004: attribute extraction at ingest — LLM extraction with
  source-span grounding, typed schemas per product type, metafield
  agreement rate as validation. Amends GW-01 acceptance criteria.
- ADR-0005: substitute ranking — exact / substitute / complement
  ordering for retrieval. Decision only for Sprint 1; build lands in
  GW-19 (Sprint 3). Chunk metadata designed by ADR-0004 must carry the
  fields substitute ranking will need.
- ADR-0006: chunking strategy (target size, overlap, hierarchical parent
  chunk). GW-01 ingestion ships with tunable placeholder parameters
  pending this ADR.
- ADR-0007: retrieval query filters — content_type / active / brand /
  document_type taxonomy and how they map onto the F2 strategy.
- ADR-0008: fusion strategy addendum (if we deviate from the experiment
  winner).
- ADR-0009: synonym dictionary / equine-domain lexeme mapping for
  `to_tsvector`.
- Addendum to this ADR: Sprint 1 fusion + rerank experiment outcome.

---

## Addendum — Sprint 1 baseline outcome (2026-09-15)

Ran the four-configuration retrieval baseline (`pnpm retrieve`) against
the 40-case Sprint 1 golden dataset. Numbers are cited from
`evals/results/sprint-1/retrieval-baseline.md`; the CLI is
reproducible via `pnpm retrieve`. All four configurations use the
noop reranker as the control — no reranker treatment was implemented
this sprint, so the "does the reranker earn its place" question is
formally deferred to Sprint 2 with a defensible answer under the
stopping rule below.

### Headline

| config | recall@5 | recall@10 | nDCG@10 | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| dense | **83.3%** | **94.4%** | 62.4% | 232 | 523 |
| sparse | 5.6% | 5.6% | 5.6% | 49 | 123 |
| hybrid-rrf | 83.3% | 94.4% | 62.4% | 235 | 283 |
| hybrid-weighted | 83.3% | 94.4% | 62.4% | 237 | 277 |

**Metric-name correction (2026-09-15).** An earlier version of this
addendum reported a "relevance" column that computed precision@10, not
nDCG@10 as the eval-harness definition demands
(`evals/groundwork_evals/metrics.py`). The numbers under that name
looked suspicious (15% next to 94.4% recall) which is what surfaced
the mislabel. The table above uses the corrected metric; recall@k and
latency numbers are unchanged.

Scored over 18 answer cases with populated source IDs. The 8
legitimately-empty answer cases (three-state negatives, brand-not-
stocked, fit gap) and 14 escalate/abstain cases are held out — per
`evals/datasets/README.md` §1 they score on `groundedness` and
`false_refusal` only.

### Stopping-rule application

The ADR's stopping rule reads: *"Fusion: pick the fusion method with
the higher recall@10 on the golden set, provided the gap is ≥3
absolute points; otherwise default to RRF (fewer parameters, one less
thing to tune). Reranker: ship a reranker iff it improves recall@10
by ≥5 absolute points AND improves groundedness by ≥3 absolute points
AND costs less than 300 ms p95 additional latency."*

Applied honestly:

- **Fusion.** RRF and weighted both land at 94.4% recall@10 in the
  numbers above, but see the caveat immediately below. Under the
  default rule (gap < 3pt, default to RRF), RRF is the placeholder
  winner pending the Sprint 2 rematch.
- **Hybrid vs dense — the comparison did not actually happen.** The
  numbers show hybrid = dense = 94.4% recall@10. That is *not* evidence
  that fusion doesn't help. It is evidence that the sparse retriever
  returned empty on almost every query (5.6% recall@10 = 1 case of 18)
  because `plainto_tsquery` uses AND semantics — see the ts_query
  finding below. **Hybrid was compared against dense-plus-nothing, not
  against dense-plus-a-working-sparse-retriever.** The honest statement
  is: hybrid could not be evaluated at Sprint 1 because one of its two
  components was returning empty. The comparison is deferred to Sprint 2
  after `plainto_tsquery` is replaced with `websearch_to_tsquery` or an
  OR-fallback.
- **What ships for Sprint 1.** Dense-only. Fusion code stays behind
  the port for the Sprint 2 rematch. This is not "hybrid showed no
  benefit over dense" — that comparison has not happened yet.
- **Reranker.** No treatment implemented; noop ships. This is the
  ADR's explicit fallback: *"If only one metric clears, ship the
  noop and re-open in Sprint 2."* Zero metrics cleared because zero
  metrics were measured. Sprint 2 spike opens the reranker
  comparison with Cohere Rerank v3 and bge-reranker-base against
  the dense-only baseline.

### Two implementation findings that surfaced during the run

**1. `chunks.embedding` was NULL on every row.** Migration 001
declared `vector(1536)` and an HNSW index, but the GW-01 ingest
pipeline (`packages/ingestion/src/ingest-cli.ts`) never called the
embedder — attribute extraction was wired to OpenAI, embeddings were
not. The first experiment run reported dense at 0.0% for exactly
that reason: nothing to search. A one-off backfill script
(`packages/retrieval-experiment/src/backfill-embeddings.ts`,
`pnpm --filter @groundwork/retrieval-experiment backfill-embeddings`)
populates all 417 chunks in ~30 s at ~$0.002 total cost. Sprint 2
should fold embedding generation into the ingest pipeline so this
gap doesn't recur on the next corpus refresh; ADR-0004's second
addendum names the ingest-runner cleanup work that includes this.

**2. `plainto_tsquery` uses AND semantics.** The sparse retriever
tokenises the customer query and requires *every* content word to
appear in the chunk. *"How much is your shavings pls"* becomes
`much & shaving & pls` — no chunk has all three, so the query
returns empty and the sparse retriever contributes zero to the
fusion. Case 007 (*"cost per bale of purple horsehage"*) hits the
same wall: nothing in the corpus contains `purple`, so the
retriever filters out every HorseHage chunk. This is why sparse
lands at 5.6% (1 of 18) — the one hit was a logistics case whose
query happened to have overlapping content words with the delivery
guide. Sprint 2 candidates: switch to `websearch_to_tsquery` (which
uses OR-with-boost by default), or add an OR-fallback in the RPC.
This is a specific pattern named in ADR-0009's synonym-dictionary
slot — the lexeme fix and the query-semantics fix are the same
Sprint 2 work item.

### One case worth calling out

**Case 007 (`product-007-purple-horsehage-price`), trade-synonym.**
The `trade-synonym` tag was introduced when this case exposed a
retrieval gap: customer says "purple", catalogue says "Timothy",
and no chunk contains "purple". Dense retrieval **hits the right
chunk (HorseHage Timothy) in top-10 but misses top-5**. Sparse
misses completely. This is the first concrete measurement showing
what ADR-0009's synonym-dictionary work would buy — dense
embeddings partially bridge the trade-shorthand gap via context
(HorseHage colour bales are described in adjacent product listings)
but not confidently enough to promote the right chunk into the
top-5. Adding the synonym mapping should lift both dense and
sparse on this class of case.

### Per-provenance / per-intent honest read

- **Real-customer cases (17 scored)** — dense at 94.1% recall@10.
  This is what the metric is designed to say: on the traffic the
  shop actually sees, the retriever finds the right chunk almost
  every time.
- **Boundary probe (1 scored — fit-029, jodhpurs)** — 100% dense.
  Not enough sample to draw a conclusion; the single case succeeded.
- **Adversarial (0 scored)** — no adversarial cases have populated
  source IDs; they're OOS/abstain cases where retrieval isn't the
  scoring axis. Nothing to report.

Per-intent breakdown for dense:

| intent | scored | recall@5 | recall@10 |
| --- | ---: | ---: | ---: |
| product | 7 | 85.7% | 100.0% |
| fit | 1 | 100.0% | 100.0% |
| logistics | 10 | 80.0% | 90.0% |

The one dense logistics miss at top-10 (out of 10 cases scored) is
worth naming honestly rather than hiding in an aggregate: dense
retrieval isn't perfect on delivery-policy questions, likely
because the query and the guide share only the *topic* rather than
overlapping lexemes ("how much is delivery" vs a guide that says
"free with no minimum"). Sprint 2 candidates the retrieval side
can address without new guides: chunk-level metadata weighting
(prefer content-type=guide when the query is policy-shaped),
or query rewriting.

### Anything that succeeded by luck

**One item worth flagging.** Case 007 (trade-synonym) hit dense
top-10 but not top-5. That partial success is *design-relevant*
(embeddings do carry some cross-lingual context) but on the
knife-edge: the miss is at rank 6, which is the kind of borderline
result that could flip case-by-case with a corpus refresh. The
addendum records this so a Sprint 2 measurement over the same case
after ADR-0009 lands can quantify the improvement.

Nothing else in the top-line result reads as luck — the 94.4%
recall@10 on real cases is genuinely broad across product,
logistics, and the single fit case that has a chunk.

### What lands from this run

- **Ship dense-only for Sprint 1**, RRF fusion code kept behind the
  port for the Sprint 2 rematch.
- **Reranker deferred to Sprint 2** with the noop as the control,
  ADR stopping rule applied as written.
- **Sprint 2 sequence** (added to Sprint log follow-ups):
  1. Fold embedding generation into `pnpm ingest` so a fresh corpus
     doesn't ship without embeddings.
  2. Switch sparse to `websearch_to_tsquery` (or OR-fallback in the
     RPC) so ts_rank has a chance to contribute signal.
  3. Re-run this baseline against the fixed sparse retriever;
     hybrid vs dense-only decision is revisited then.
  4. Reranker spike: dense-only vs dense+Cohere Rerank v3 vs
     dense+bge-reranker-base.
  5. ADR-0009 (synonym dictionary) — measure case 007's top-5 hit
     rate before and after.
- **Guide gaps recorded but NOT closed this sprint** per the Job-3
  brief. Cases 026, 027, 030 remain at `[]` awaiting the
  saddle-fitting and girth-fitting guides listed in ADR-0003's
  second addendum.

The Sprint 1 baseline is defensible: on the traffic that exists, on
the corpus that exists, dense retrieval finds the right chunk in the
top-10 for 17 of 18 scored answer cases. That's not the ceiling —
Sprint 2 has an actionable list of things that could each lift the
number — but it's a real number the design document can carry into
the next iteration.

---

## Addendum — Sprint 2 rematch (2026-09-16)

Sprint 2 resolved finding #2 (`plainto_tsquery` AND semantics) and
reran the four-configuration baseline. First real hybrid-vs-dense
measurement in this project.

### The four-sprint baseline table

Format is append-only; Sprint 3 adds a row when the reranker spike
lands. All numbers computed on cases with populated
`required_source_ids` — 18 cases in the Sprint 2 rematch, same
denominator as Sprint 1.

| sprint | config           | recall@5 | recall@10 | nDCG@10 | p50 ms | p95 ms | notes |
| ------ | ---------------- | -------: | --------: | ------: | -----: | -----: | ----- |
| 1      | dense (shipped)  |    83.3% |     94.4% |   62.4% |    232 |    523 | sparse returning empty; hybrid uncomparable. |
| 2      | dense            |    88.9% |    100.0% |   65.1% |    217 |    377 | reconciled source_ids (see below), not directly comparable to sprint 1 dense. |
| 2      | sparse           |    83.3% |     88.9% |   53.2% |     41 |     50 | up from 5.6% recall@10 in sprint 1 — sparse fix worked. |
| 2      | **hybrid-rrf**   |    **94.4%** | **100.0%** | **65.7%** |    218 |    283 | first real hybrid measurement; beats dense-only by 5.5pt recall@5. |
| 2      | hybrid-weighted  |    94.4% |    100.0% |   65.6% |    218 |    261 | ties hybrid-rrf on this dataset; RRF wins on parameter count. |

### Stopping-rule outcome — hybrid > dense, RRF wins fusion

- **Fusion.** RRF and weighted tie on recall@5, recall@10, nDCG@10.
  Under the ADR's rule ("gap < 3pt, default to RRF"), **RRF ships as
  the fusion strategy for Sprint 2 and beyond.**
- **Hybrid vs dense.** Hybrid-rrf beats dense-only by 5.5pt on
  recall@5 (94.4% vs 88.9%). Under the stopping rule threshold for
  hybrid promotion ("improves recall@k by ≥3pt over the shipped
  baseline"), **hybrid-rrf is promoted from behind-the-port to the
  shipped path.** The Sprint 1 recommendation ("ship dense-only")
  is superseded: **Sprint 2 ships hybrid-rrf.**
- **Latency cost of hybrid.** Hybrid p50 = 218ms vs dense-only p50 =
  217ms — sparse (41ms p50) runs in parallel with dense in the
  hybrid retriever's implementation, so hybrid's latency floor is
  dense's floor. Within budget by an order of magnitude.

### Finding resolutions

- **Finding #1 (chunks.embedding NULL) — resolved in Sprint 2** via
  `8d87bae` (ingest fold-in). GW-01 lesson written up in
  `docs/ai-assisted-development.md`.
- **Finding #2 (plainto_tsquery AND semantics) — resolved in Sprint
  2** via migration `003_sparse_or_semantics.sql` (commit `4cc6bd4`).
  Each customer-query word is now passed through `plainto_tsquery`
  individually and OR-combined with the `||` tsquery operator.
  Rerun confirms sparse recall@10 went from 5.6% to 88.9%.

### Third instance of the "no underlying signal" family

Rerunning the baseline after the sparse fix initially returned
**0.0% recall across all four configurations** — including dense,
which the migration didn't touch. Diagnosis (recorded in
`docs/ai-assisted-development.md`): the corpus had been re-ingested
at some point since the Sprint 1 baseline was locked (probably as
part of the GW-01 embedding fold-in), and every re-ingest generates
fresh `gen_random_uuid()` chunk IDs. The `required_source_ids` in
the golden dataset pointed at UUIDs that no longer existed. The
recall calculation had 18 cases to score against — and found 0
matches for any of them.

This is the third instance of the family GW-01 and GW-10 exposed:

- **GW-01** — ingest reported 297 attributes stored, but every
  `chunks.embedding` was NULL.
- **GW-10** — LLM emitted `confidence` = 0.90 uniformly, no
  calibration to whether the classification was correct.
- **Sparse-fix rematch (this addendum)** — retrieval-experiment
  reported recall percentages, but the ground-truth
  `required_source_ids` were invalidated by an upstream ingest with
  no signal to the dataset.

Same shape all three times: **an artefact of pipeline shape
that carries no underlying signal about pipeline behaviour.** The
number is truthful (297 attributes really were extracted; the LLM
really did emit 0.90; the recall really was 0.0%) but the number
doesn't measure what the reader thinks it measures. The general
rule from `docs/ai-assisted-development.md` (Sprint 2 entry —
"any field a downstream consumer will threshold on gets a
calibration check before the consumer is written") applies here
too: any UUID a golden-set consumer will grep for should be
verified against the current source-of-truth before the consumer
runs. The sparse-fix rematch would have surfaced this on any
retrieval run against any modified corpus.

### Reconciliation and the "not apples-to-apples" caveat

Fix: `evals/scripts/reconcile_source_ids.py` — a rerunnable
reconciler that reads each case's declared retrieval target (product
handle or guide slug + section), looks up the current chunk IDs from
the deployed corpus, and rewrites the JSONL in place.

Reconciled targets were made section-specific for guide-backed
cases (rather than dumping every chunk of the guide) so recall
numbers stay comparable-in-granularity to Sprint 1. Two small
permissiveness increases were unavoidable:

- Cases 017–020 (superseded-source cases) gained the
  "Superseded policy" chunk as a valid retrieval target — Sprint 1
  didn't include it, but the correct answer to a customer quoting
  an old policy legitimately involves that chunk.
- Case 020 gained the opening-hours "Superseded" chunk for the
  same reason.

Sprint 1 → Sprint 2 dense delta (83.3% → 88.9% recall@5) is
therefore partly reconciliation-permissiveness, partly real. Within
Sprint 2, dense vs sparse vs hybrid comparisons are on the same
reconciled dataset and are apples-to-apples.

### What ships from this rematch

- **Hybrid-rrf becomes the default retrieval configuration.** The
  Sprint 1 note "fusion code stays behind the port for the Sprint 2
  rematch" is now discharged: fusion is in the shipped path.
- **RRF wins fusion.** Weighted stays available but ties on this
  dataset; RRF is simpler.
- **Reranker spike still deferred to Sprint 3** — same rationale
  as Sprint 1 addendum (ADR's fallback rule triggers when zero
  metrics have cleared for the reranker treatment; nothing was
  measured for reranker in Sprint 2 either).
- **ADR-0009 (synonym dictionary)** — case 007 was still in the
  Sprint 2 misses on the sparse config (0.83 recall — one case
  short of 100%). The trade-synonym gap is unchanged, and adding
  synonyms remains a Sprint 3 candidate.
