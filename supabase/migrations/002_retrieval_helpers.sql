-- ============================================================================
-- Retrieval helper functions
-- ----------------------------------------------------------------------------
-- Two SECURITY DEFINER functions callable via PostgREST RPC. They wrap
-- the pgvector cosine search and Postgres full-text search so the
-- retriever adapters (packages/adapters/src/retriever/) can call one
-- SQL statement each rather than hand-rolling the query.
--
-- ADR-0001 committed to hybrid dense + sparse. This migration exposes
-- the two independently so a) each can be evaluated on its own in the
-- Sprint 1 baseline, and b) the hybrid retriever composes them at the
-- adapter layer using the fusion strategy the experiment picks.
--
-- Both return chunk id + document_id + text + score in one shot to
-- match the Retriever port's RetrievedChunk shape and avoid a second
-- round trip for the fields the caller needs anyway.
-- ============================================================================

-- Dense retrieval — cosine distance via pgvector's <=> operator.
-- Returns similarity (1 - distance) so higher-is-better across dense
-- and sparse; the fusion layer wants uniform score orientation.
--
-- match_count is the top-k. Callers over-fetch (typically 4x per
-- ADR-0001 F2) when a WHERE filter is applied above the RPC.
create or replace function search_chunks_dense(
  query_embedding vector(1536),
  match_count int
)
returns table(chunk_id uuid, document_id uuid, chunk_text text, score float)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id as chunk_id,
    c.document_id,
    c.text as chunk_text,
    (1 - (c.embedding <=> query_embedding))::float as score
  from chunks c
  where c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- Sparse retrieval — ts_rank over the generated tsvector column.
-- Note that this is ts_rank NOT BM25 (see ADR-0001, sparse index note).
-- If ts_rank turns out to be the retrieval bottleneck, ADR-0001 names
-- pg_search (ParadeDB) as the upgrade path.
--
-- plainto_tsquery is used so callers can pass arbitrary customer
-- query text without escaping — & | ! and parentheses are treated as
-- lexemes rather than operators.
create or replace function search_chunks_sparse(
  query_text text,
  match_count int
)
returns table(chunk_id uuid, document_id uuid, chunk_text text, score float)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id as chunk_id,
    c.document_id,
    c.text as chunk_text,
    ts_rank(c.content_tsv, plainto_tsquery('english', query_text))::float as score
  from chunks c
  where c.content_tsv @@ plainto_tsquery('english', query_text)
  order by ts_rank(c.content_tsv, plainto_tsquery('english', query_text)) desc
  limit match_count;
$$;

-- Grant execute to authenticated + anon so the retriever service key
-- can call these. Service role bypasses RLS but PostgREST still
-- respects function-level EXECUTE grants.
grant execute on function search_chunks_dense(vector(1536), int) to anon, authenticated, service_role;
grant execute on function search_chunks_sparse(text, int) to anon, authenticated, service_role;
