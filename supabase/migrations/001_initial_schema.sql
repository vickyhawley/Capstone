-- ============================================================================
-- Groundwork initial schema
-- ----------------------------------------------------------------------------
-- Design target: ~50k chunks, ~10k products (see docs/adr/0001).
-- Sprint 1 seed:  ~5k chunks,  ~500-1000 products.
--
-- HNSW parameters and indexes below are sized for the design target, not the
-- seed. Retaining headroom means we don't rebuild indexes when the corpus
-- grows through Sprints 2+. If real-world scale departs materially from the
-- design target, revisit `m` and `ef_construction` in a follow-up migration
-- rather than editing this one.
-- ============================================================================

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ============================================================================
-- documents
-- Raw source records ingested from the retailer's content library, product
-- descriptions, fit guides, and supplier PDFs. One row per source object;
-- chunked content lives in `chunks`.
-- ============================================================================
create table if not exists documents (
  id             uuid primary key default gen_random_uuid(),
  source         text not null,                    -- e.g. 'shopify', 'pdf', 'markdown'
  source_ref     text not null,                    -- upstream identifier (URL, SKU, filename)
  title          text not null,
  url            text,
  content_type   text not null,                    -- 'product', 'guide', 'policy', 'faq'
  language       text not null default 'en',
  content_hash   text not null,                    -- sha256 of raw body; enables idempotent re-ingest
  ingested_at    timestamptz not null default now(),
  metadata       jsonb not null default '{}'::jsonb,
  constraint documents_source_ref_unique unique (source, source_ref)
);

create index if not exists documents_content_type_idx on documents (content_type);
create index if not exists documents_source_idx on documents (source);

-- ============================================================================
-- chunks
-- Retrievable units. One document splits into many chunks. Carries both a
-- dense embedding (semantic search) and a tsvector (BM25/lexical search) to
-- support the hybrid strategy in ADR-0001.
-- ============================================================================
create table if not exists chunks (
  id                uuid primary key default gen_random_uuid(),
  document_id       uuid not null references documents (id) on delete cascade,
  ordinal           integer not null,              -- 0-based position within the document
  parent_chunk_id   uuid references chunks (id),   -- hierarchical context; null for top-level
  text              text not null,
  token_count       integer not null,
  embedding         vector(1536),                  -- OpenAI text-embedding-3-small dim; adjust if model changes
  content_tsv       tsvector generated always as (to_tsvector('english', text)) stored,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  constraint chunks_document_ordinal_unique unique (document_id, ordinal)
);

-- HNSW for dense ANN. Parameters sized for the design target (~50k rows).
--   m=16: standard graph degree; balances build cost and recall.
--   ef_construction=64: default; recall levels off above this at our scale.
-- Sprint 1 will benchmark recall@k and may retune.
create index if not exists chunks_embedding_hnsw_idx
  on chunks
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- GIN over tsvector for lexical search alongside the dense index. Note:
-- Postgres full-text ranking here is `ts_rank` (or `ts_rank_cd`), NOT BM25.
-- Real BM25 would need pg_search or a bespoke ranking function; ts_rank is
-- what we've committed to for Sprint 1 (see ADR-0001, sparse index note).
create index if not exists chunks_content_tsv_idx on chunks using gin (content_tsv);

create index if not exists chunks_document_id_idx on chunks (document_id);

-- GIN on chunks.metadata for JSONB `@>` filter path. The retrieval strategy
-- (ADR-0001) over-fetches by 4× top-k and filters via SQL; this index makes
-- the filter clause cheap. `jsonb_path_ops` restricts operators to `@>` but
-- gives a smaller, faster index than the default `jsonb_ops`.
create index if not exists chunks_metadata_idx on chunks using gin (metadata jsonb_path_ops);

-- ============================================================================
-- products
-- Structured product records. Distinct from `documents`: this is the source
-- of truth for facts (SKU, price, dimensions). The catalogue tool reads from
-- here; the LanguageModel never does. See CatalogueRepository port.
-- ============================================================================
create table if not exists products (
  id             uuid primary key default gen_random_uuid(),
  sku            text not null unique,
  name           text not null,
  brand          text not null,
  category       text not null,                    -- e.g. 'saddle', 'rug', 'boot', 'supplement'
  description    text not null,
  attributes     jsonb not null default '{}'::jsonb, -- size chart, materials, dimensions
  active         boolean not null default true,    -- soft-delete flag; retains history for eval reproducibility
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists products_category_idx on products (category);
create index if not exists products_brand_idx on products (brand);
create index if not exists products_name_trgm_idx on products using gin (name gin_trgm_ops);

-- ============================================================================
-- conversations
-- One row per user session. Referenced by messages and traces.
-- ============================================================================
create table if not exists conversations (
  id             uuid primary key default gen_random_uuid(),
  user_ref       text,                             -- opaque anonymised user identifier; null for pre-login
  started_at     timestamptz not null default now(),
  ended_at       timestamptz,                      -- populated when the session closes cleanly
  channel        text not null default 'web',      -- 'web', 'staff-review', future channels
  metadata       jsonb not null default '{}'::jsonb
);

create index if not exists conversations_user_ref_idx on conversations (user_ref);
create index if not exists conversations_started_at_idx on conversations (started_at desc);

-- ============================================================================
-- messages
-- One row per turn. `refusal_reason` is populated when the safety gate stops
-- generation; it's queryable so the correct-abstention metric can be computed
-- without re-reading the model output.
-- ============================================================================
create table if not exists messages (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references conversations (id) on delete cascade,
  role              text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content           text not null,
  refusal_reason    text,                          -- non-null iff the assistant refused; enum-shaped: 'clinical', 'welfare', 'out-of-scope', 'safety'
  citations         jsonb not null default '[]'::jsonb, -- array of {chunkId, documentId, span}
  tool_calls        jsonb not null default '[]'::jsonb, -- array of {name, args, result_ref}
  created_at        timestamptz not null default now()
);

create index if not exists messages_conversation_id_idx on messages (conversation_id, created_at);
create index if not exists messages_refusal_reason_idx on messages (refusal_reason) where refusal_reason is not null;

-- ============================================================================
-- traces
-- One row per pipeline span (safety-gate, router, retrieval, rerank,
-- synthesis, tool-call, refusal). Structured for the eval harness and for
-- shop-staff conversation review.
-- ============================================================================
create table if not exists traces (
  id                uuid primary key default gen_random_uuid(),
  trace_id          uuid not null,                 -- correlates spans across a single request
  span_id           uuid not null,
  parent_span_id    uuid,                          -- forms the span tree within a trace
  conversation_id   uuid references conversations (id) on delete cascade,
  message_id        uuid references messages (id) on delete set null,
  span_kind         text not null check (
    span_kind in ('safety-gate','router','retrieval','rerank','synthesis','tool-call','refusal')
  ),
  started_at        timestamptz not null,
  duration_ms       integer not null,
  attributes        jsonb not null default '{}'::jsonb, -- span-kind-specific fields (e.g. topK for retrieval)
  error             text,
  created_at        timestamptz not null default now(),
  constraint traces_span_id_unique unique (span_id)
);

create index if not exists traces_trace_id_idx on traces (trace_id, started_at);
create index if not exists traces_conversation_id_idx on traces (conversation_id, started_at);
create index if not exists traces_span_kind_idx on traces (span_kind, started_at desc);

-- ============================================================================
-- updated_at trigger for products
-- ============================================================================
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists products_set_updated_at on products;
create trigger products_set_updated_at
  before update on products
  for each row execute function set_updated_at();
