-- ============================================================================
-- Groundwork initial schema — data + retrieval only.
-- ----------------------------------------------------------------------------
-- Design target: ~50k chunks, ~10k products (see docs/adr/0001).
-- Sprint 1 seed:  ~5k chunks,  ~500-1000 products.
--
-- HNSW parameters and indexes below are sized for the design target, not the
-- seed. Retaining headroom means we don't rebuild indexes when the corpus
-- grows through Sprints 2+. If real-world scale departs materially from the
-- design target, revisit `m` and `ef_construction` in a follow-up migration
-- rather than editing this one.
--
-- Scope note (2026-09-22): earlier revisions of this file also defined
--   - `conversations` (session table with `user_ref`, `channel`, ...)
--   - `messages`      (per-turn message log)
--   - `traces`        (`id uuid` PK, `span_kind` enum, FK to conversations)
-- Those three were scaffolding for a plan that got superseded before any
-- code was written against them. The authoritative shapes now live in:
--   - migration 004 — traces (ADR-0015, flat single table keyed on
--     (trace_id, span_id), `kind` field, no FK back to conversations)
--   - migration 005 — conversations (ADR-0017, single-row JSONB history)
-- On any environment that ran the pre-cleanup 001, migration 005 drops
-- the legacy `conversations` + `messages` tables before creating the
-- new shape. See 005 for the drop-cascade rationale.
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
-- conversations / messages / traces — moved out of 001 (see file header).
--   - traces live in migration 004 (ADR-0015).
--   - conversations live in migration 005 (ADR-0017).
--   - messages was scaffolding for a per-turn log that never got wired;
--     the concept lives inside `conversations.history` (JSONB) now.
-- ============================================================================

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
