# ADR-0013 — Deterministic chunk IDs: hash of (document_id, ordinal, content)

- **Status:** Proposed (2026-09-16, Sprint 3 planning — build early
  in Sprint 3 before GW-25 trace logging starts persisting chunk IDs
  anywhere new).
- **Deciders:** Vix Hawley (author), supervisor (approver).
- **Related stories:** Sprint 3 Story 1 (deterministic chunk IDs
  build); GW-25 (trace logging — this ADR is a precondition so
  trace logs don't become the fourth-instance failure).
- **Related ADRs:** ADR-0003 (corpus composition — chunks are the
  unit of retrieval), ADR-0004 (attribute extraction — persistence
  ships extracted attributes into `chunks.metadata`).
- **Related history:** `docs/ai-assisted-development.md` Sprint 2
  entry ("sparse-fix rematch: stale UUIDs, third instance of the
  family") — the discovery that prompted this ADR.

## Context

Three instances in three sprints of the same failure family
("plausible output, no underlying signal") have surfaced. All three
are documented in `docs/ai-assisted-development.md`:

- **GW-01** — ingest reported 297 attributes stored across 120
  documents; every `chunks.embedding` was NULL.
- **GW-10** — LLM classifier emitted `confidence = 0.90` on 40 of
  40 cases; the field was uncorrelated with correctness.
- **Sparse-fix rematch (Sprint 2, 2026-09-16)** — retrieval-
  experiment reported "recall@10 = 0.0%" across every configuration;
  the recall calculation was correct but compared against
  `required_source_ids` that pointed at chunk UUIDs the corpus had
  regenerated on a re-ingest.

The third instance is the only one with a **structural fix
available at the schema layer**. The first two required detection
after the fact (a metric to catch NULL fields, a calibration test
to catch uncalibrated confidence). The third can be prevented at
the source: change the identity contract for chunks so that
re-ingesting identical content produces identical IDs.

### The current identity contract

`supabase/migrations/001_initial_schema.sql` declares:

```sql
create table if not exists chunks (
  id                uuid primary key default gen_random_uuid(),
  document_id       uuid not null references documents (id) on delete cascade,
  ordinal           integer not null,
  ...
  constraint chunks_document_ordinal_unique unique (document_id, ordinal)
);
```

Two properties matter:

1. `id` defaults to `gen_random_uuid()`. Every insert produces a
   fresh, random UUID. Two ingests of the same corpus produce two
   entirely different sets of IDs.
2. `(document_id, ordinal)` is already declared unique. There is
   already a *natural key* for a chunk — it just isn't the primary
   key.

The reconciler script and the retrieval-experiment preflight
(shipped in Sprint 2) are workarounds for property (1). They
detect and repair stale references *after* the corpus has changed
underneath the golden set. They do not prevent the invalidation
from happening.

Any Sprint 3+ consumer that stores chunk IDs — trace logs (GW-25),
staff-console review artefacts (GW-26), any cached retrieval result
— inherits the same invalidation risk unless the identity contract
changes. A trace log full of transient UUIDs is the same class of
failure waiting to recur.

## What this ADR decides

**Chunks are identified by a deterministic UUID computed at ingest
time** from `(document_id, ordinal, content_hash)`. Same input →
same UUID, across any number of ingests. Content change → new UUID.

Concretely:

```ts
function computeChunkId(documentId: string, ordinal: number, text: string): string {
  const contentHash = sha256(text);
  const input = `${documentId}:${ordinal}:${contentHash}`;
  const hex = sha256(input); // 64 hex chars
  return uuidFormat(hex.slice(0, 32)); // "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

The output is a syntactically valid UUID (`8-4-4-4-12` format) but
not a spec-compliant v5 UUID (v5 mandates a namespace UUID and a
specific hashing scheme). Syntactic validity is enough — Postgres
`uuid` type doesn't care about version bits, and every consumer
treats these as opaque IDs.

### Why this identity contract

- **Idempotent re-ingest.** Rerunning `pnpm ingest` against
  unchanged content produces the same IDs. Golden-set references
  survive.
- **Content-change detection.** If a chunk's text changes (chunker
  boundary shift, source content edit, attribute-extraction rerun
  changing the metadata that inflates into the chunk text), its
  ID changes. That's the correct signal — the referenced chunk is
  no longer semantically the same chunk.
- **No app-side reconciliation for the common case.** The
  reconciler + preflight become defence-in-depth (catch the rare
  case where content did change and the golden set needs
  updating), not the primary safety net.
- **Structural fix, not detection.** The failure that consumed
  half a session on 2026-09-16 becomes impossible for the same
  cause. Different causes (chunker actually changed the text) are
  correctly flagged rather than silently invalidated.

## Options considered

### Option A — Deterministic hash on primary key (chosen)

Compute the chunk's `id` at ingest time as
`sha256(document_id || ':' || ordinal || ':' || sha256(text))`
formatted as a UUID.

- **Pros.** Most robust. Same schema surface for consumers.
  Idempotent re-ingest of unchanged content. Content changes get
  new IDs (correct behaviour). No runtime lookup cost.
- **Cons.** Computed in application code (Postgres defaults
  can't reference other columns without a trigger). Requires
  ingest-code change + one-time transition. Chunk ID leaks
  partial content hash — not a security concern given the
  `chunks` table is service-role-only, but worth naming.
- **Migration cost.** Small at 500-chunk scale (see Migration
  strategy below).

### Option B — Reference by (document, ordinal)

Golden cases store `(document_source_ref, chunk_ordinal)` tuples
instead of chunk UUIDs. The `chunks_document_ordinal_unique`
constraint already provides the natural key. Chunk IDs remain
`gen_random_uuid()`.

- **Pros.** No schema change. Human-readable references
  (`{handle: "aubiose-hemp-bedding", ordinal: 0}`). Cheap to
  implement.
- **Cons.** Chunk ordinal is fragile too — re-chunking with
  different boundary rules (a Sprint 3+ ADR-0006 outcome) changes
  ordinals silently. Requires eval-time resolution logic in every
  consumer that reads golden `source_ids` (Python harness,
  retrieval-experiment, any trace-log analyser). Doesn't help
  consumers that need chunk IDs *at runtime* (retrieval returns
  IDs; a trace log stores what retrieval returned). Would require
  a parallel indirection layer.
- **Rejected because:** the runtime problem (trace logs storing
  transient IDs) survives this fix. Option B addresses the golden
  set specifically; Option A addresses the identity contract for
  every consumer.

### Option C — Content-anchor resolution at run time

Golden cases store a stable content excerpt (first ~80 chars, or
a section title); the harness looks up the current UUID at run
time.

- **Pros.** Most robust to *any* schema change. Human-readable.
  Handles chunker changes if the anchor text still exists in
  some chunk.
- **Cons.** Ambiguous when multiple chunks contain the anchor
  text. Runtime lookup cost on every eval run. Anchor text drifts
  if content is edited (correcting a typo in a policy guide
  changes the anchor). Same "doesn't help runtime consumers"
  problem as Option B.
- **Rejected because:** same runtime problem as B plus ambiguity
  risk. A "purple horsehage" anchor could match any chunk that
  mentions "purple horsehage"; the golden set author wanted a
  specific one.

### Why not fix the failure family with detection alone

The Sprint 2 sparse-fix close-out shipped both a reconciler and a
preflight check. Together they detect and repair the specific
class of failure they cover. They cost real engineering time (~2
hours of debugging + ~1 hour of fix work in Sprint 2), and they
have to run *before* every consumer that trusts chunk IDs. That
"before every consumer" surface grows with every story that adds
a new consumer.

Structural fix is worth doing when:
1. The failure is recurring (three instances so far).
2. A schema-level change closes the entire class, not one member.
3. The migration cost is bounded (500 chunks, one leaf table).

All three hold. Detection stays as defence-in-depth.

## Migration strategy

The chunks table is a leaf in the FK graph (nothing outside chunks
points *into* chunks.id except chunks itself via
`parent_chunk_id`). The `parent_chunk_id` self-reference is
currently unused — every ingested chunk today has
`parent_chunk_id: null` (see `packages/ingestion/src/persistence.ts:113`).
The unused self-reference means migration doesn't have to
reconcile parent pointers.

### The migration itself — one deliberate sequence, nothing else in flight

Truncate + re-ingest invalidates every `required_source_id` at
once. Between the truncate and a successful reconcile, the golden
set points at nothing and any consumer of source IDs sees the
same "0.0% across every configuration" state the sparse-fix
rematch discovered. A failed migration plus a half-reconciled
dataset is the worst state to be in — it looks like a regression
but is a housekeeping incident. So this runs as one deliberate
sequence with nothing else touching the corpus or the eval
harness in between.

The sequence, in order, with a stop condition at each step:

1. **Ship `computeChunkId`.** Add the function to
   `packages/ingestion/src/persistence.ts`. Change the insert
   path to pass explicit `id: computeChunkId(document_id,
   ordinal, text)`. Use Supabase `upsert({...}, { onConflict:
   'id' })` so re-ingesting unchanged content is idempotent by
   design. Land the code change; do not run ingest yet. Verify
   `pnpm --filter @groundwork/ingestion typecheck` + tests pass.

2. **Truncate `chunks`.** Operator step, one SQL statement:

   ```sql
   truncate chunks;
   ```

   Destructive on `chunks` only. `documents` stays intact. The
   `on delete cascade` on `documents.id` is not triggered
   because we're truncating `chunks` directly, not deleting
   documents.

3. **Re-ingest.** `pnpm ingest`. Every chunk gets a
   deterministic ID from the function shipped in step 1.
   Embeddings are re-computed (Sprint 2's fold-in handles this
   in one pass). At 500 chunks + ~$0.002 and ~30s, this is
   bounded. **Stop condition:** ingest reports the expected
   chunk count and every chunk has a non-null embedding. If it
   doesn't, do not proceed to step 4 — the golden set will be
   reconciled against the wrong state.

4. **Reconcile the golden set.**
   `evals/scripts/reconcile_source_ids.py --apply`. Rewrites
   `required_source_ids` against the new IDs. **Stop
   condition:** the reconciler reports zero warnings. Any
   warning means a golden case references a product handle or
   guide section that no longer exists in the corpus, and that
   needs an author decision before continuing.

5. **Confirm the preflight passes.**
   `pnpm --filter @groundwork/retrieval-experiment retrieve`
   should print `Preflight: all N unique required_source_ids
   exist in chunks.` If it doesn't, roll back mentally: the
   reconciler in step 4 succeeded against IDs that step 3 did
   not create. Investigate before continuing.

6. **Only then continue.** Everything else — Sprint 3 story
   work, harness runs, retrieval experiments — waits for the
   preflight-passes signal in step 5. This is the "one
   deliberate sequence, nothing else in flight" discipline: no
   partial state is committed, no measurement is trusted until
   the whole sequence has closed.

From this point forward, re-ingests preserve IDs. The
reconciler becomes a no-op verifier. Its `summary: 0 case(s)
changed` output is the durability check.

### What the reconciler script becomes

The reconciler stays in-tree. Its role changes:

- **Before this ADR:** the recovery mechanism after every ingest.
- **After this ADR:** the verification mechanism after any
  suspected content change. Its expected output is
  `summary: 0 case(s) changed`. Non-zero output is a signal that
  something changed the corpus content, which may or may not have
  been intended.

Rename / repurpose deferred to a Sprint 3 follow-up rather than
handled in this ADR — the script name still makes sense as a
reconciler when there IS drift, and calling it before the
content-drift is unnecessary ceremony.

### What the retrieval-experiment preflight becomes

The preflight added in Sprint 2 stays. Its role also changes:

- **Before this ADR:** catches every re-ingest that invalidated
  the golden set.
- **After this ADR:** catches genuine content drift only —
  someone edited a guide, chunker parameters changed, a chunk
  disappeared. Signal is louder because it should be zero-fire
  on the common path.

### The load-bearing → defence-in-depth transition

After this ADR lands, **the reconciler and the preflight are
defence-in-depth, not load-bearing.** They stay in the tree.
They should stop firing on the common path.

- **Reconciler expected behaviour:** `summary: 0 case(s)
  changed` on every run. Non-zero output is a genuine content-
  change signal — a guide was edited, a product was
  re-catalogued, a chunker parameter shifted.
- **Preflight expected behaviour:** silent pass on every run.
  `Preflight: all N unique required_source_ids exist in chunks.`
- **If preflight fires after this ADR ships, something else is
  wrong.** Not a stale-UUID re-ingest problem (that class is
  closed). Likely candidates: a chunk was deleted directly, a
  document was removed, an ingest ran against a different
  corpus, or the golden set has a stale reference the reconciler
  should have caught. **Investigate; do not just re-run the
  reconciler.** Automated re-reconcile would hide the underlying
  event that changed the corpus.

The "should stop firing" property is what makes this ADR worth
building rather than just tolerating the reconciler +
preflight indefinitely. Their continued firing after this ADR
ships would be a signal that the ADR didn't do what it claims.

## Consequences

- **Positive.** The failure recorded in
  `docs/ai-assisted-development.md` Sprint 2 entry becomes
  impossible for its stated cause. Any future consumer that
  stores chunk IDs (trace logs, staff console, cached retrieval)
  inherits durable references without needing to know about the
  reconciler.
- **Positive.** Content drift becomes an observable event —
  a chunk's ID changing is a signal. Trace analytics that rely
  on chunk-level joins across time can trust that "same ID =
  same content." Absent this, cross-time analysis needs a
  separate content-hash column.
- **Neutral.** The `id` column is no longer a random opaque
  identifier — it's a partial content hash. Not a security
  concern given `chunks` is service-role-only, and the ID doesn't
  reveal document contents beyond a hash-preimage guess that's
  computationally infeasible. Named here so it's not surprising.
- **Neutral / minor negative.** Ingest code takes on a small
  computational cost (one SHA-256 per chunk) plus an
  application-side ID assignment. At sprint 1 scale this is
  invisible; at design-target scale (50k chunks) it's still <
  1s of ingest total. Not a bottleneck.
- **Negative.** The one-time transition is destructive on
  `chunks`. The operator has to run it explicitly. Not a
  reversible operation (re-ingest rebuilds, but any drift
  between old and new corpus is not detectable at truncate
  time). Mitigated by the small chunk count and the ~30s
  re-ingest cost.

## Cases this does NOT solve

- **Content drift the ingest doesn't notice.** If a chunker
  change re-splits the same source document into chunks with
  different `ordinal` values (e.g. old-chunker made 3 chunks
  per document, new-chunker makes 5), the IDs change and the
  golden set references break. This is correct behaviour — the
  chunks really are different — but it triggers reconciliation.
  ADR-0006 (chunking strategy) is where the "when do we accept
  a chunker change" question belongs.
- **The Python harness's own consumption of `required_source_ids`.**
  The Python harness uses source_ids to compute `recall_at_k`
  against `retrieved_chunk_ids` returned by the API. Both live
  IDs come from the same DB, so they'll match. But if the DB
  has been re-truncated and the golden set hasn't been re-
  reconciled, `recall_at_k` scores 0 silently. The Sprint 2
  Python-harness preflight follow-up (see sprint-log Sprint 2
  close-out for the sparse-fix) is what addresses this — this
  ADR doesn't.
- **Any consumer that already cached chunk IDs before this ADR.**
  Nothing does yet at Sprint 3 planning time. GW-25 (trace
  logging) is the first would-be example, and it ships after
  this migration, so it stores deterministic IDs from day one.

## Reproducibility note

The migration is a destructive one-time transition. Recorded here
so it's not surprising when Sprint 3 Story 1 asks the operator
to run `truncate chunks` and `pnpm ingest` in sequence. Because
`documents` is preserved and re-ingest rebuilds `chunks` from
the same source content, the operation is *effectively*
reversible — the "old" chunks table content can be recomputed
from `pnpm ingest --reset-to-old-chunker-config` if a rollback
were ever needed. Neither the ingest CLI's `--force` flag nor
the reconciler need to be modified for this migration; both
work as-is.

The precondition for this ADR landing is: no chunk IDs are
persisted anywhere outside `chunks` yet (the golden set is the
only consumer that stores them, and the reconciler handles that).
GW-25 (trace logging) will be the first persistence of chunk IDs
outside the table itself, so this ADR ships before GW-25 — that's
why it's Sprint 3 Story 1.
