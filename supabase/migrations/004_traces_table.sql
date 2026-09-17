-- ============================================================================
-- Trace persistence table for GW-25.
-- ----------------------------------------------------------------------------
-- One row per Span. Shape mirrors packages/core/src/ports/trace-sink.ts
-- exactly. See ADR-0015 for design decisions:
--   - flat single table (decision 1)
--   - composite PK on (trace_id, span_id) — makes duplicate emits
--     detectable at insert time (decision 2, decision 10)
--   - attributes as JSONB (decision 3)
--   - three indexes: trace_id, started_at, GIN on attributes (decision 4)
--   - service-role only, no anon/authenticated grants (decision 7)
--   - append-only (no upsert path — duplicate is a bug worth surfacing)
--   - text (not uuid) for trace_id + span_id because the port types
--     them as `string`, and the tool loop's default spanId generator
--     produces 8 hex chars (not UUID-shaped). Sprint 4+ can tighten
--     to uuid if that becomes worth it.
--
-- Non-destructive. No existing data touched.
-- ============================================================================

create table if not exists traces (
  trace_id       text not null,
  span_id        text not null,
  parent_span_id text,
  kind           text not null check (kind in (
    'safety-gate', 'router', 'retrieval', 'rerank',
    'synthesis', 'tool-call', 'refusal'
  )),
  started_at     timestamptz not null,
  duration_ms    integer not null,
  attributes     jsonb not null default '{}'::jsonb,
  error          text,
  created_at     timestamptz not null default now(),
  primary key (trace_id, span_id)
);

-- Most common query: all spans for one turn. Enables the GW-26 staff
-- console's "show me trace X" view.
create index if not exists traces_trace_id_idx on traces (trace_id);

-- Time-range queries for the eval harness + recent-activity views.
create index if not exists traces_started_at_idx on traces (started_at desc);

-- Enables `attributes @> '{"tool_name": "stock-lookup"}'` containment
-- queries and `attributes ? 'error'` existence queries against
-- arbitrary attribute keys. See ADR-0015 §3.
create index if not exists traces_attributes_gin on traces using gin (attributes);

-- Service role only. Traces contain no PII per the TraceSink port
-- contract but they do carry model rationales, tool arguments, and
-- retrieval targets — none of which are anon-safe. Anon/authenticated
-- have no route to write or read.
grant insert, select on traces to service_role;

-- Enable RLS with no policies. service_role bypasses RLS by design
-- (Supabase's built-in service_role behaviour), so writes and reads
-- via the SupabaseTraceSink adapter — which authenticates with
-- SUPABASE_SERVICE_ROLE_KEY — continue to work. anon and
-- authenticated get default-deny on every operation. Defence-in-
-- depth against a future GRANT that would otherwise silently expose
-- the table. Sprint 3 2026-09-17: chunks + documents don't have
-- this yet; captured as a follow-up.
alter table traces enable row level security;
