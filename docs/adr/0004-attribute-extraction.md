# ADR-0004 — Attribute extraction at ingest, LLM with source-span grounding

- **Status:** Proposed (2026-09-15, Sprint 1 — pending sign-off before
  any extraction code lands as part of GW-01)
- **Deciders:** Vix Hawley (author), supervisor (approver)
- **Related stories:** GW-01 (amended — see sprint log 2026-09-15
  scope-change entry), GW-19 (substitute ranking, Sprint 3; ADR-0005),
  ADR-0003 (corpus composition — this ADR expands the chunk metadata
  ADR-0003 introduced)

## Context

ADR-0003 committed to two document types (products + guides) as the
corpus shape. This ADR is the next decision inside that shape: how
does structured, filterable information get into the product-record
chunks?

The evidence is the same catalogue profile (`scripts/profile_catalogue.py`,
against `data/catalogue/products.csv`). The facts customers ask about
are in the descriptions but are not addressable:

- The Equidry Aura description states a 20,000 mm waterproof rating
  and 32,000 g/m²/24hr breathability. The
  `outerwear-clothing-features` metafield is populated on 5 of 398
  products.
- Feeding rates appear in 1–5% of descriptions depending on pattern
  strictness (see ADR-0003). The `animal-feed-form` metafield is
  populated on 55 products (14%), but that captures *form* not
  *rate*.
- Colour is the best-covered metafield at 109 of 398 products (27%),
  and even there almost three-quarters of the catalogue lacks a
  structured value.

Semantic retrieval alone finds the descriptions, but a bot cannot
*filter* on "waterproof ≥ 15,000 mm" without the fact being
addressable. And a substitute-ranker (ADR-0005, Sprint 3) needs
comparable attributes across products of the same type to say "this
is the equivalent we stock." Neither works from prose alone.

## Options considered

### Option A — Prose only, rely on semantic retrieval

Do nothing beyond ADR-0003. Trust dense embeddings to surface the
right descriptions.

- **Pros.** Zero ingestion complexity; no extraction cost; no new
  failure mode.
- **Cons.** Filters and substitute ranking do not work. A user asking
  "do you have a rug with at least 15,000 mm waterproofing?" gets
  either a hedge or a retrieval that happens to surface products
  whose descriptions mention high mm values — a coincidence, not a
  filter. Fit-question metrics stay poor for the reasons ADR-0003
  already named.

### Option B — Hand-author structured attribute data

Populate the missing Shopify metafields (or a bespoke sidecar table)
by hand for the 398 products. Retrieval reads structured values
directly.

- **Pros.** Fully structured, high-precision, no LLM cost, no
  hallucination surface. Shopify-native so shop staff can maintain
  it in the tooling they already use.
- **Cons.** Data-entry project, not an engineering one. Sprint 1
  budget doesn't cover backfilling ~370 products × ~5 attributes.
  Also doesn't scale — every catalogue refresh (new suppliers, new
  ranges) needs the same effort. NFCS is a small independent shop;
  the ongoing maintenance burden is real.

### Option C — LLM extraction at ingest with source-span grounding

An LLM reads each product's title, description, and variant options
and emits typed attributes per product type. Every attribute carries
a confidence and a source span — the exact substring of the
description the value came from. Attributes with no source span are
dropped as hallucinations, not stored. Extraction runs once per
product at ingest and is idempotent — a subsequent ingest with the
same input produces the same output and skips products whose
`content_hash` and prompt haven't changed.

- **Pros.** Turns the prose the SME already writes into structured
  metadata a retriever and a substitute-ranker can both filter on.
  Cost is a one-off per product (see below); ongoing catalogue
  changes trigger extraction only on new or changed rows.
  Source-span grounding makes hallucinations visible and refusable
  at ingest time rather than at answer time.
- **Cons.** Adds an LLM dependency to the ingestion path, and a
  failure mode — plausible-but-ungrounded values slipping through
  if the source-span check is weak. Adds a new schema surface
  (typed attributes per product type) that has to be maintained.
  Metafield coverage (colour at 27%) gives a limited-scale
  validation signal, not a proof of correctness on the other 73%.

## Decision

**Adopt Option C — LLM extraction at ingest with source-span
grounding.**

### Extraction shape

For each product, the extractor emits an `ExtractedAttribute` per
attribute in the product-type schema:

```typescript
type ExtractedAttribute = {
  key: string;                    // e.g. 'waterproof_mm', 'feeding_rate_g_per_100kg'
  value: string | number | null;  // null iff the description does not support a value
  confidence: number;             // 0.0-1.0 from the model
  sourceSpan: {                   // required iff value is not null
    text: string;                 // the substring the value came from
    start: number;                // char offset in the source description
    end: number;
  } | null;
};
```

- `value: null` is a **true fact about the catalogue**, not a failure.
  A feed bag with no stated feeding rate has no feeding rate; the
  assistant should abstain rather than infer one from category
  knowledge.
- `value: not-null && sourceSpan: null` is a **hallucination** and is
  dropped at write time, not stored. Enforced by a unit test on the
  extractor output shape.
- Confidence is stored but not used to filter this sprint. It exists
  so downstream retrieval and eval can slice performance by
  confidence bucket once we have data.

### Typed schemas per product type

Attribute schemas live in `packages/core/src/attribute-schemas/`,
one file per product type. Each schema is a static object naming the
attributes to extract, with a short description of each for the
prompt. Schemas are testable — a schema file that references a
product type not in the catalogue's `Type` column fails a unit test,
and the extractor refuses to run against a product whose type has no
schema (better to skip than to guess).

Sprint 1 lands schemas for the highest-volume product types visible
in the synthetic order fixtures:

- **Feed** — feeding rate (g per 100 kg horse per day), species,
  life stage, pack size (kg), form (mix / pellet / cube / balancer).
- **Bedding** — material, bale size (kg or L), dust-extracted (bool),
  intended species.
- **Haylage** — cut type, bale weight (kg), moisture profile.
- **Supplements** — target concern, active ingredients,
  daily dose (g or ml), pack duration (days), form.
- **Outerwear** — waterproof rating (mm), breathability (g/m²/24hr),
  insulation (g fill), fit (turnout / stable / travel).

Other product types (bridles, boots, saddles, dog feed) get schemas
as GW-01's persistence commit adds retrieval coverage against them.
Adding a schema is an additive change, not a re-ingest event.

### Model choice and cost

**Commit: OpenAI `gpt-4o-mini` for extraction.** Reasoning:

- Native structured-output support (JSON schema mode), which makes
  the source-span discipline enforceable at the API surface rather
  than at parse time.
- Cheap: rough per-product cost at ~1 k input tokens (title + tags
  + description + schema prompt) and ~300 output tokens is
  ~$0.0002 per product at posted list prices. Full 398-product
  extraction ≈ $0.08. A per-sprint re-extraction under this
  ballpark is not a cost decision.
- Already in the LLM adapter's provider set from ADR-0001; no new
  vendor onboarding.

Extraction cost is not the bottleneck; **latency** at ingest matters
more. Sprint 1 can afford minutes of ingest wall-clock time; if
Sprint 3+ needs to re-ingest often (new supplier bulk imports),
we'll batch or parallelise. Not premature to optimise now.

### Idempotency and re-ingest

Cache the extractor output alongside the chunk. The cache key is
`sha256(product_content_hash + prompt_version + schema_version)`.
Re-ingest with unchanged inputs hits cache and skips the LLM call.

Every catalogue refresh runs the extractor only on rows whose
`content_hash` changed since last ingest, plus any rows whose
schema has been amended (schema version bump forces re-extract for
all products of that type).

### Metafield validation (agreement rate)

The 109 products with Shopify's `Color` metafield populated are the
cheapest available ground truth. After each full extract:

1. Run the extractor over those 109 products.
2. Compare its extracted `colour` value to the metafield value. Case-
   and whitespace-insensitive; allow simple aliases (navy / dark
   blue, tan / beige).
3. Report **agreement rate** — the fraction where extractor value
   matches metafield value. Lands in the sprint log as an
   observability number; lands in this ADR's addendum as the first
   measurement.

**Shipping threshold.** If agreement is below 80% on the colour
subset, GW-01 does not close with extraction on. Options at that
point are (a) tighten the schema / prompt for colour specifically,
(b) narrow the product types where extraction runs, or (c) fall
back to Option A and record the failure. This ADR does not
prejudge which; the decision is what to do if the number is bad.

Metafields override extraction where both are present. Where the
extractor says one thing and the metafield says another for a
product that has the metafield populated, the metafield wins.
Where the metafield is empty and the extractor produced a
grounded value, the extractor's value is stored.

## Prior work

Attribute value extraction from product data is a documented line
of research. Cited here for methodological context; Groundwork is
not inventing a technique.

- **OpenTag** (Zheng, Ma, Nag, Malmasi, Zeghidour, 2018) — introduced
  the sequence-tagging framing of attribute value extraction from
  product titles; used a BiLSTM-CRF over token sequences with
  learned tag schemata. Established that open-vocabulary extraction
  is feasible from short product text.
- **AdaTag** (2021) — adaptive attribute-value extraction that
  handles both known-attribute and open-attribute extraction with
  a shared model, using attribute-name embeddings as conditioning.
  Addressed the "new attribute at ingest time" case.
- **AttriSage** (2024) — graph-based aggregation of attribute
  evidence across product families, using product-taxonomy edges
  to propagate attribute values between related SKUs. Relevant to
  Groundwork's per-type schema design, though we don't build the
  aggregation this sprint.
- **AutoPKG** — automatic product knowledge graph construction
  pipelines; the general shape of "extract, normalise, link" that
  our pipeline follows.

**What Groundwork does differently.** These are trained extraction
models: they need labelled data (attribute-value spans annotated on
a training corpus of product descriptions) and produce
probability-calibrated outputs. Groundwork uses a **zero/few-shot
LLM pass with a source-span grounding requirement**. That trades
model accuracy — trained models remain the ceiling on published
benchmarks — for the ability to ship without a labelled dataset
NFCS does not have. The source-span requirement is the
compensating discipline: an extractor that cannot show its work
gets dropped, not trusted. That maps directly onto Groundwork's
answer-path rule (every claim binds to a source), applied at
ingest.

Groundwork is also single-shop, small-catalogue (~400 products),
not the multi-million-SKU marketplace the cited papers target.
The precision/recall trade-off is skewed further toward precision
here — a wrong stored attribute affects hundreds of downstream
answers, and there are fewer products so the marginal cost of
manual review of low-confidence extractions is bearable.

## Consequences

**Positive.**

- Retrieval can filter on structured attributes at query time
  (`waterproof_mm >= 15000`, `feeding_rate_g_per_100kg`
  present), unblocking fit and feeding questions that ADR-0003
  named as the coverage ceiling.
- Substitute ranking (ADR-0005, GW-19) gets the fields it needs
  from day one; no re-ingest at Sprint 3.
- Source-span grounding makes extractor quality auditable — the
  eval harness can slice by "attributes with spans" vs "attributes
  without" and observe the answering quality gap.
- The 80% shipping threshold makes the "does the extractor actually
  work?" question a number, not an opinion.

**Negative.**

- New failure mode: plausible-but-ungrounded attribute values. The
  source-span rule catches most; the eval harness's abstention
  metrics catch the rest. Watch closely in the first weeks.
- New surface: attribute-schema-per-product-type files. Adding a
  new product type requires a schema commit before extraction runs
  for it. This is a feature (opinionated schemas) but requires
  discipline (no shipping a new supplier without a schema).
- Ingest wall-clock time grows by the extractor latency. On the
  Sprint 1 seed corpus (~400 products) this is minutes, not hours;
  becomes worth optimising if Sprint 2+ ingests larger batches.
- The colour-metafield validation is 27% of the catalogue and one
  attribute. Agreement there is a signal, not a proof, of extraction
  quality on the other 73% or on non-colour attributes. Sprint 2
  should widen the validation surface (feed form metafields, animal
  age group) as those subsets are large enough to compute agreement
  on.

**Reversibility.** Medium. Attribute values stored in
`chunks.metadata` can be dropped in-place without changing chunk
IDs (the metadata is a jsonb key that's additive). But if the
chunk *text* is composed to include the extracted attributes
(rather than the attributes living only in metadata), then a
re-ingest to remove them changes chunk hashes and IDs. The GW-01
implementation should keep extracted attributes in metadata only
this sprint, not folded into chunk text, precisely so the
reversibility stays cheap while the extractor's quality is still
being measured.

## Failure mode to watch, named explicitly

If the extractor starts producing attribute values that read as
plausible but aren't grounded in the source description, **stop
extraction and surface the failure** rather than tightening the
prompt until the output looks right. Tightening the prompt hides
the failure; the source-span rule exists to make it visible. This
is the same discipline the answer path enforces (a plausible
answer without a citation is not shipped) applied at ingest.

Concretely: the ingest runner logs any product where the extractor
returned a non-null value without a source span. If that count is
non-zero, GW-01 does not close.

## Follow-ups

- GW-01 implementation — the chunker library ships alongside this
  extractor, and the two-commit split (chunkers → persistence) is
  logged in the sprint log.
- ADR-0005 — substitute ranking. Uses the attributes this ADR
  extracts. Chunk metadata design must include product type,
  vendor, and comparable-attribute keys so GW-19 doesn't require
  a re-ingest.
- ADR-0006 — chunking strategy. Determines whether extracted
  attributes appear in chunk text or metadata only; this ADR's
  reversibility argument leans metadata-only, but the chunking ADR
  is the final call.
- Sprint 2 — widen the metafield-agreement validation to `Animal
  feed form` (55 products), `Age group` (22 products), and any
  other populated metafields with enough sample to compute a rate.
- Sprint 2 — expose a "attributes without span" observability
  counter on `/api/health` so the failure mode above is visible
  in production, not just at ingest.

---

## Addendum — First live run outcome (2026-09-15)

Recorded here so the ADR carries its own operational history. Both
runs against Supabase project `vwmdtzwuetpebinflwbs` with catalogue
`data/catalogue/products.csv` (398 products, 1,454 variant rows).

### Run 1 — verifier-fault first pass

| metric | value |
| --- | --- |
| Products extracted | 120 (of 120 with a matching schema) |
| Extraction errors | 0 (OpenAI billing was topped up between attempts) |
| Attributes stored | 5 |
| Attributes dropped | 303 (296 `source-span-mismatch`, 7 `value-without-source-span`) |
| Colour agreement sample | 0 |
| Elapsed | 243.9 s |

**Interpretation.** 296 of 303 drops fired on the offset-equality
check in `coerceSourceSpan`. The model was quoting the right words
but reporting offsets that didn't line up (a well-known LLM
weakness — models quote well and count characters poorly). The
check demanded both, so real groundedness proofs were being
rejected on a counting technicality. This is not the failure mode
this ADR warned about: it's the *inverse* — the guardrail was
over-catching, rather than being fooled by plausible fabrications.

**Action.** Fixed the verifier to check `source.indexOf(text) >= 0`
and compute offsets server-side (commit `b96007e`). Test suite
updated to lock the new semantics. This is not prompt-tightening
(which this ADR forbids); it's aligning the check with the
grounding contract the ADR actually names ("value came from a
substring of the description", not "offsets exactly correct").

### Run 2 — post-verifier-fix

| metric | value |
| --- | --- |
| Products extracted | 120 |
| Extraction errors | 0 |
| Attributes stored | 297 |
| Attributes dropped | 13 (8 `source-span-mismatch`, 5 `value-without-source-span`) |
| Colour agreement sample | 1 (100.0%) |
| Elapsed | 248.5 s |

### Colour-agreement finding

The 80% shipping gate could not be measured. Of the 120 products
in the extraction set, 70 have a populated `Color` metafield in
Shopify. Of those 70, only **one** ended up in the agreement
sample. The reason: the `Color` metafield on feed and bedding
products records the *bag or pellet colour* ("yellow" for
Strawmax pellets, "silver" for HiLight Veteran Mix), which is
almost never named in the product description text. The extractor
correctly returned `colour: null` for those — the description does
not support a value — and that's the intended behaviour under this
ADR's null-is-a-true-fact rule.

**This is a finding about the ground-truth choice, not an
extractor failure.** The `Color` metafield tests whether the
extractor can *find* colours in descriptions where colours are
mentioned. On this catalogue that's a much narrower slice than
109 products.

### Shipping decision

**Ship extraction on the 297 stored attributes.** GW-01 closes.

The 80% shipping gate was not the discipline the run actually
needed — it required a ground-truth signal broader than we have.
The 13-out-of-310 drop rate (~4%) is the guardrail behaving as
designed: it's catching a small number of hallucinations and
quote-not-in-source cases without false-catching real
groundedness proofs.

Two follow-ups replace the unmeasurable gate:

- **Sprint 2 — hand-review spot check.** Take a random sample of
  30 stored attributes, verify each against its `source_span` and
  the underlying description by hand. Any hallucination or
  wrong-attribution found lowers confidence in the extractor and
  triggers a re-open on this ADR. This is harder-to-cheat
  validation than the metafield-agreement rate because it
  measures against the actual grounding evidence rather than
  against a proxy signal.
- **Sprint 2 — the earlier follow-up (widen metafield-agreement
  validation to `Animal feed form`, `Age group`) remains valid**
  as a lower-cost supplementary check. Animal feed form is more
  likely to appear in descriptions than pellet colour.

### What actually changed vs the ADR

- The verifier contract, made explicit above.
- The shipping gate's usability, noted here so a future reader
  doesn't repeat the same expectation. The 80% threshold was well
  reasoned as a design decision; only the applicability to this
  particular ground truth turned out to be off.

The main body of the ADR is unchanged. The decision to extract
attributes with source-span grounding at ingest, using
gpt-4o-mini and typed per-product-type schemas, holds.

### Per-attribute coverage (run 2, all in-schema products)

Aggregate "297 stored across 120 products" hides which attributes
the extractor is finding. Disaggregated by
`packages/ingestion/src/coverage-cli.ts` (`pnpm coverage`, read-only,
reproducible on the same corpus). `non-null` = extractor returned
a value with source_span; `null` = extractor explicitly returned
value=null (fact not in source); `missing` = attribute not emitted
at all.

**Feed (n = 90 — the largest sample and therefore the informative one):**

| attribute | non-null | null | missing |
| --- | ---: | ---: | ---: |
| `form` | 91.1% | 5 | 3 |
| `species` | 78.9% | 12 | 7 |
| `pack_size_kg` | 46.7% | 34 | 14 |
| `life_stage` | 24.4% | 31 | 37 |
| `feeding_rate_g_per_100kg_per_day` | **1.1%** | 37 | 52 |
| `colour` | 2.2% | 37 | 51 |

**Bedding (n = 8):** `material` 100%, `dust_extracted` and
`intended_species` 62.5%, `bale_size` 12.5%, `colour` 0%.

**Haylage (n = 6):** `cut_type` 100%, `moisture_profile` 50%,
`bale_weight_kg` and `colour` 16.7%.

**Supplements (n = 14):** `form` 100%, `target_concern` 92.9%,
`active_ingredients` 64.3%, `daily_dose_g` 21.4%,
`pack_duration_days` 0%, `colour` 0%.

**Outdoor Rugs (n = 2):** too small to draw conclusions —
`colour` and `fit` 100%, `waterproof_mm` and `breathability` 0%.

**Reading the Feed row is the one that matters.** `feeding_rate` at
1.1% is not the extractor hedging. It's the corpus. 89 of 90 feed
descriptions do not state a feeding rate in words. This is exactly
the coverage gap ADR-0003 diagnosed against the raw CSV — the
extraction pass hasn't invented facts that weren't there. So on the
question ADR-0003 set out to answer ("can product descriptions
alone answer feeding questions?"), the answer is *still* no, and
the post-extraction number confirms that the fault lay in the
source, not in the extraction layer.

**Where extraction is worth its cost** is the addressable-fact
axes that *are* present in prose but weren't structured: `form`
(91.1%), `species` (78.9%), `target_concern` (92.9%),
`active_ingredients` (64.3%), `material` (100%), `cut_type`
(100%). Filters on these become viable at retrieval time; they
weren't before.

**The "missing" column** shows the model sometimes omits an
attribute entirely rather than emitting `value: null`. 52 of the
89 non-answered feeding_rate cases fall this way. Sprint 2 prompt
refinement could shift "missing" to "null" without changing the
meaningful non-null numbers; the current prompt says "for each
attribute in the schema return one entry" but the JSON schema
allows the model to skip. Low-priority polish.
