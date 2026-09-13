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

- ADR-0002: chunking strategy (target size, overlap, hierarchical parent
  chunk).
- ADR-0003: retrieval query filters — content_type / active / brand
  taxonomy and how they map onto the F2 strategy.
- ADR-0004: fusion strategy addendum (if we deviate from the experiment
  winner).
- ADR-0005: synonym dictionary / equine-domain lexeme mapping for
  `to_tsvector`.
- Addendum to this ADR: Sprint 1 fusion + rerank experiment outcome.
