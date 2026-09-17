# ADR-0015 — Trace persistence: append-only `traces` table, JSONB attributes, narrow duplicate handling

- **Status:** Proposed (2026-09-17, Sprint 3 planning — this ADR
  precedes the GW-25 implementation. Same discipline as ADR-0010/
  0011/0014 preceded their stories.)
- **Deciders:** Vix Hawley (author), supervisor (approver).
- **Related stories:** GW-25 (this ADR — trace persistence). GW-18
  emits spans through the `TraceSink` port; GW-25 is the durable
  landing surface. GW-24 (model tiering + cost capture) — this ADR
  reserves a home in trace attributes for per-call token counts and
  cost, so GW-24 doesn't retrofit or build a second mechanism.
  GW-26 (staff console) — first real reader of the traces table;
  see the producer-ahead-of-consumer note in Consequences.
- **Related ADRs:** ADR-0002 (iteration bound vs timeout — the loop
  that emits spans respects this contract, this ADR is downstream),
  ADR-0013 (deterministic chunk IDs — trace attributes will carry
  chunk IDs; ADR-0013 makes them durable references across re-ingests),
  ADR-0014 (tool loop — the trace emission hooks this ADR persists).
- **Related port:** `packages/core/src/ports/trace-sink.ts` — the
  `Span` shape is the source of truth for what a row in this table
  looks like.

## Context

Sprint 2 shipped the boundary layer; Sprint 3 Story 2 (`252794f`)
shipped the tool loop and wired its span emissions through the
`TraceSink` port. Every tool call today emits a `tool-call` span
carrying tool name, args, ok, duration, retryable flag, and any
rationale the planner provided. `StubTraceSink` silently swallows
them.

GW-25 is the persistence. Once traces land in a queryable table,
subsequent stories can (a) attribute per-call costs to specific
turns (GW-24), (b) show the staff console what a turn actually did
(GW-26), (c) run post-hoc analytics on retrieval and tool
behaviour, and (d) give the eval harness a substrate for slicing
metrics by trace attributes.

The port docstring already declares two important properties that
downstream design has to respect:

> **Sinks are best-effort — a sink failure MUST NOT fail the parent
> request. Implementations should log and swallow.**

> **PII redaction happens before this port. The sink does not scan.**

Both hold. The adapter throws on infrastructure failure and the
tool loop's `safeTraceRecord` swallows; PII handling belongs to the
caller (`/api/answer`) not to the sink.

## What this ADR decides

**Ten decisions**, four of them reflecting the plan-review pass
2026-09-17:

### 1. Flat table, one row per span

```sql
create table traces (
  trace_id text not null,
  span_id text not null,
  parent_span_id text,
  kind text not null check (kind in (
    'safety-gate', 'router', 'retrieval', 'rerank',
    'synthesis', 'tool-call', 'refusal'
  )),
  started_at timestamptz not null,
  duration_ms integer not null,
  attributes jsonb not null default '{}',
  error text,
  created_at timestamptz not null default now(),
  primary key (trace_id, span_id)
);
```

Alternative rejected: separate tables per span kind. Would be
premature normalisation; the seven span kinds share enough
structure (all have trace_id, span_id, timing, attributes) that a
flat table with a `kind` discriminator is simpler. Splitting is a
Sprint 4+ concern if per-kind analytics queries dominate.

### 2. Composite primary key on `(trace_id, span_id)` — not a surrogate

The port models a span's identity as `trace_id + span_id`. The
composite PK matches. A surrogate row `id` would let duplicate
`(trace_id, span_id)` inserts land silently — the composite PK
makes duplicates detectable at insert time (Postgres error code
`23505`, unique_violation).

Plan-review pass confirmed: **duplicates should be detectable, not
silent.** Composite PK stays.

### 3. `attributes` as JSONB, not flattened columns

The port declares `attributes: Readonly<Record<string, string |
number | boolean>>`. Different span kinds carry different keys —
`tool-call` spans have `tool_name`, `iteration`, `ok`; router spans
will have `intent`, `matched`, `confidence`. JSONB lets each kind
write its own shape without a wide table full of nulls.

Query pattern uses `attributes->>'tool_name'` for text extraction,
`attributes @> '{"ok": true}'` for containment. The GIN index in
decision 4 makes both fast.

Adding a column later is easy; unpicking a flattening isn't.
Plan-review pass confirmed. JSONB stays.

### 4. Three indexes

- `create index traces_trace_id_idx on traces (trace_id)` — most
  common query, "all spans for one turn." Enables the GW-26 staff
  console's "show me trace X" view.
- `create index traces_started_at_idx on traces (started_at desc)`
  — time-range queries. The eval harness will want to filter
  traces by run window; a staff console dashboard wants recent
  activity.
- `create index traces_attributes_gin on traces using gin
  (attributes)` — enables containment and existence queries
  against arbitrary attributes. `attributes @> '{"tool_name":
  "stock-lookup"}'` for tool-specific analytics; `attributes ?
  'error'` for any span with an error field.

No index on `kind`. Cardinality is 7; a partial scan is fine at
this scale. Adding later if a query pattern needs it.

### 5. Best-effort write via port contract, adapter throws on infra failure

The `TraceSink` port already declares best-effort behaviour, and
`tool-loop.ts`'s `safeTraceRecord` wraps every `record()` call in
try/catch. So the adapter can throw internally on real DB failures
(network partition, table doesn't exist, permission denied) and
the loop stays clean.

**Exception: unique_violation on duplicate `(trace_id, span_id)`
is caught narrowly.** See decision 10.

### 6. No retention rotation in Sprint 3 — Sprint 4 candidate with a concrete trigger

Plan-review pass corrected the initial "Sprint 4+" framing to a
concrete trigger. Retention becomes a decision, not drift:

**Trigger for retention design work — whichever fires first:**
- Row count exceeds **1,000,000**. At current scale (~200 turns/
  day production × ~10 spans/turn = 2000 rows/day), that's ~500
  days of production. Comfortable ceiling.
- Date reaches **2027-01-01**. Three-months-past-Sprint-3 forcing
  function — even if scale is slow, retention semantics get a
  decision.

Whichever comes first, Sprint 4 opens with "review retention
policy for traces table" as a story. Not "consider retention" —
"decide retention." Options at that point are likely 30-day / 90-
day rotation via `pg_partman` or a scheduled job.

### 7. No RLS surprises — service-role write, no anon/authenticated grants

Traces contain no PII per port contract. Service role writes and
reads. No grants to anon or authenticated. Matches the pattern for
`chunks`.

### 8. Cost + token attributes reserved for GW-24

GW-24 (model tiering + cost capture) will emit spans (router calls,
planner calls, synthesis calls) with per-call cost and token
counts. This ADR reserves standard attribute keys so GW-24 lands
into this shape rather than building a separate cost table:

- `input_tokens: number` — model input token count.
- `output_tokens: number` — model output token count.
- `cost_usd: number` — total USD cost for the call.
- `model: string` — the model identifier (e.g. `gpt-4o-mini`,
  `claude-sonnet-4-6`). Enables tier-level cost analytics via
  `attributes->>'model'`.

Any span kind can carry these when applicable — router calls do,
tool-call spans that themselves invoke an LLM do, synthesis spans
do. Retrieval spans typically don't. The attribute keys are
optional (per JSONB — no schema enforcement), documented here so
GW-24 has a landing surface.

### 9. `chunk_id` attributes reference deterministic IDs — no FK

Retrieval and synthesis spans will carry chunk IDs in their
attributes (e.g. `attributes.retrieved_chunk_ids: [...]`). JSONB
doesn't support foreign keys cleanly, so no FK is added.

Durability comes from ADR-0013: chunk IDs are now deterministic
hashes of `(document_id, ordinal, content)`. A chunk ID stored in a
trace attribute today will still reference the same chunk after any
re-ingest of unchanged content. If content changes, the ID changes
correctly — and the trace becomes a historical record of "chunk X
was retrieved when its content was Y," which is the correct shape
for post-hoc analysis of behaviour changes.

### 10. Duplicate-emit — narrow catch on `23505` + in-memory counter

Plan-review pass named the shape: **a hard throw puts an exception
on a path the port contract says must be inert; a blanket swallow
makes the bug invisible.** Both extremes are wrong.

The adapter narrowly catches Postgres error code `23505`
(unique_violation), increments an in-memory counter on the adapter
instance, and logs a `console.error` on each hit. Any other error
code propagates (real infra failure — network partition, table
doesn't exist — is worth surfacing to the loop's try/catch).

The counter is exposed via a public getter so a future health-
check endpoint (`/api/health` or `/api/traces/health`) can surface
"duplicate spans this process: N." A non-zero N is the loud
signal that the loop is emitting the same span twice.

**Why in-memory not persisted:** Sprint 3 doesn't need aggregable
metrics across processes. A restart resets the counter, which is
fine — if duplicates are happening they'll happen again after
restart. Aggregating across processes is a Sprint 4+ concern
(paired with the retention decision).

## What this ADR does NOT do

Named so they don't slide into GW-25's scope.

- **Read side.** No `/api/traces` endpoint, no `getTracesForId(id)`
  method on the port. GW-26 (staff console) is the first reader.
  GW-25 is write-only.
- **Retention rotation.** Sprint 4 candidate with the concrete
  triggers in decision 6.
- **Per-kind schemas / typed attributes.** JSONB stays untyped;
  the attribute keys in decision 8 are documented conventions, not
  enforced schema. Typed accessors are a Sprint 4+ concern if
  needed.
- **Aggregation queries.** No materialised views, no summary
  tables. GW-26 owns whatever aggregation the staff console needs.
- **Trace correlation across turns.** Each `/api/answer` request
  gets a fresh `trace_id`. Multi-turn conversation memory (GW-16,
  Sprint 4) will introduce conversation-level identifiers if
  needed. Not this ADR.

## Consequences

### Positive

- Every tool call, retrieval, and (eventually) synthesis event
  becomes queryable. Sprint 3+ stories that want to slice
  behaviour by attribute have a persistent substrate.
- GW-24 has a home for cost/token attributes without building a
  parallel mechanism.
- GW-26 has a queryable data source rather than reconstructing
  events from logs.
- Duplicate emissions from the loop are detectable (composite PK)
  and surfaced (counter + log line) without failing the parent
  request.

### Negative — producer-ahead-of-consumer risk

**This adapter is write-only and no code reads traces until
GW-26.** That's the producer-ahead-of-consumer shape that's bitten
this project twice:

- **GW-01 (Sprint 1):** ingest wrote embeddings that no test
  consumed for real. `chunks.embedding` was NULL on every row and
  no gate caught it. First real read (GW-02's retrieval baseline)
  reported 0.0% recall.
- **Sparse-fix rematch (Sprint 2):** the reconciler script relied
  on `find_chunks.py`'s output; no test verified the reconciler
  against a live DB. First real read (GW-02's rerun) discovered
  the stale-UUID class of failure.

To not become the third instance, **GW-25's implementation must
include a manual SQL smoke test as part of its acceptance**,
performed *in the same session as the code lands*, not deferred to
GW-26. The check: hit `/api/answer` with an answer-behaviour case,
then `select * from traces where trace_id = 'X' order by
started_at` and confirm the expected rows appear with correct
column values.

Sprint 3 GW-25 close-out is not signed off without that manual
verification. Recorded here so it can't slide.

### Neutral

- `attributes` as JSONB means query performance for common
  attribute filters depends on the GIN index. Postgres GIN on
  small JSONB documents is fast at Sprint 3 scale. If it becomes
  a bottleneck, decision 3's "adding a column later is easy" holds
  — promote heavily-queried attributes to columns.
- The append-only insert means the table grows monotonically until
  decision 6's retention trigger fires. Bounded by the trigger.

## Migration + rollback

**Migration `004_traces_table.sql`** — one `create table`, three
indexes, one grant statement. Non-destructive; no existing data
touched.

**Rollback:** revert the adapter code (swap `SupabaseTraceSink`
back to `StubTraceSink` in `defaultAnswerDeps` + `server.ts`),
optionally `drop table traces`. Everything else keeps working —
the loop's `safeTraceRecord` swallows the sink change either way.

## Reproducibility note

This is a design ADR; implementation lands in the same GW-25
close-out that ships migration 004, the `SupabaseTraceSink`
adapter, and the mandatory SQL smoke. Same discipline as GW-10 /
GW-14 / GW-18 — design first, implementation follows verbatim.
