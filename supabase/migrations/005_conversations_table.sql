-- ============================================================================
-- Conversation memory table for GW-16.
-- ----------------------------------------------------------------------------
-- One row per multi-turn conversation. Shape mirrors packages/core/src/
-- ports/conversation-store.ts. See ADR-0017 for design decisions:
--   - single-table-with-JSONB-history (decision 1) — matches ADR-0015
--     trace precedent; whole conversation is one row read; no join.
--   - conversation id is server-generated uuid (decision 2) —
--     clients never mint their own; prevents id-collision attacks
--     and lets the server enforce shape.
--   - history JSONB shape: array of {turn_id, role, text, created_at}
--     (decision 3). turn_id stable across replays; role in
--     {'user', 'assistant'}; text is verbatim user query or
--     final assistant answer (not intermediate deltas).
--   - append-only from the port's perspective (appendTurn), but the
--     table row is UPDATEd on each append (single-row shape). Concurrent
--     appends to the same conversation race — mitigated by client-side
--     serialisation (one in-flight request per conversation, enforced
--     by Chat.tsx's pending flag) and by transactional read-modify-
--     write in the adapter.
--   - service-role only, no anon/authenticated grants (decision 5).
--     Conversation history contains customer queries — treat as PII-
--     adjacent.
--   - RLS enabled with no policies. Defence-in-depth against a
--     future GRANT.
--
-- Non-destructive on the trace table (adds a nullable column). DESTRUCTIVE
-- on the legacy `conversations` + `messages` tables — see cleanup block
-- below.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Legacy cleanup: earlier revisions of migration 001 defined `conversations`
-- (session table with user_ref/started_at/channel/metadata) and `messages`
-- (per-turn message log). Both were scaffolding for a plan that got
-- superseded before any code was written against them — nothing in the
-- current codebase reads or writes either table. On a fresh DB seeded from
-- the post-cleanup 001, both `drop`s are silent no-ops. On any DB that ran
-- the pre-cleanup 001, this reclaims those two tables before the new
-- `conversations` shape below can land.
--
-- CASCADE handles the FK from `messages.conversation_id` (dropped with the
-- parent) and any lingering FK on `traces.conversation_id` if 001's traces
-- shape was ever present. The current traces table (migration 004, ADR-0015)
-- carries no FK and no data would be lost.
--
-- Sanity check before running in prod: `select count(*) from conversations`
-- should return 0. This project is pre-launch; the tables were provisioned
-- but never populated. If you inherit this file on a DB where either table
-- has real rows, STOP and back up before running 005.
-- ----------------------------------------------------------------------------
drop table if exists messages      cascade;
drop table if exists conversations cascade;

create table if not exists conversations (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  turn_count   integer not null default 0,
  history      jsonb not null default '[]'::jsonb
);

-- Most common query: load one conversation by id. Covered by the
-- primary-key index; no additional index needed.

-- Time-range queries for eventual retention/rotation policy (post-
-- capstone roadmap item, tracked in project-board.md).
create index if not exists conversations_updated_at_idx
  on conversations (updated_at desc);

-- Service role only. Conversation history carries customer queries;
-- treat as PII-adjacent. anon/authenticated get default-deny.
grant insert, select, update on conversations to service_role;

alter table conversations enable row level security;

-- Link every trace back to its conversation. Nullable because pre-
-- GW-16 traces exist without one and a per-turn API call may still
-- happen outside a conversation (e.g., health-check-style probes,
-- eval harness runs). No FK — traces are append-only and long-lived;
-- a conversation delete should not cascade to lose eval evidence.
alter table traces
  add column if not exists conversation_id uuid;

create index if not exists traces_conversation_id_idx
  on traces (conversation_id);
