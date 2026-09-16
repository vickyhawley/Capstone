-- ============================================================================
-- Sprint 2 — fix the sparse retriever's AND-semantics failure
-- ----------------------------------------------------------------------------
-- Sprint 1 baseline finding #5 (see docs/sprint-log.md § Sprint 1 findings,
-- and ADR-0001's addendum on the ts_query AND-semantics failure): the
-- sparse retriever scored recall@10 = 5.6% because `plainto_tsquery`
-- combines every content word in the query with `&` (AND). A customer
-- query like *"How much is your shavings pls"* becomes
-- `much & shaving & pls`. No chunk contains all three lexemes, so the
-- query returns empty and the sparse component contributes nothing to
-- hybrid fusion.
--
-- This migration replaces `search_chunks_sparse` with an OR-chained
-- form. Each word in the customer query is normalised through
-- `plainto_tsquery` individually (which handles stemming, stopword
-- removal, and lexeme extraction the same way `to_tsvector` did when
-- `content_tsv` was populated), then combined with the `||` tsquery
-- OR operator. Bare words < 2 chars are dropped (they'd stem to
-- stopwords or reduce to empty tsqueries anyway).
--
-- Two properties this preserves from the migration-002 version:
--
-- 1. **Same function signature.** Adapter code
--    (packages/adapters/src/retriever/pg-ts-rank-retriever.ts) does not
--    change. Callers keep passing raw customer text; the SQL side
--    handles all tokenisation and normalisation.
-- 2. **No user-supplied operator injection.** Each word is passed to
--    `plainto_tsquery` individually, which treats `&`, `|`, `!`, and
--    parentheses as lexemes rather than tsquery operators. A hostile
--    query like `x | admin` cannot escalate to `x OR admin` — it
--    parses as two literal lexemes.
--
-- Behaviour change: sparse now matches ANY overlap between query and
-- chunk (weighted by how many overlap via `ts_rank`), rather than
-- requiring every word to appear. This is the semantics `websearch_to_tsquery`
-- would give for user-typed OR queries, but applied automatically
-- because customers don't type OR.
--
-- Trade-off: precision drops (sparse now returns something for almost
-- every query, including irrelevant hits). This is why fusion with
-- dense matters — dense filters the OR-chain's over-recall down to
-- the semantically relevant subset, and hybrid fusion (RRF or
-- weighted) can now actually differ from dense-only. The Sprint 1
-- baseline row (dense-only shipped because sparse was empty) gets a
-- companion Sprint 2 row where hybrid is compared against a working
-- sparse, per ADR-0001 addendum.
-- ============================================================================

create or replace function search_chunks_sparse(
  query_text text,
  match_count int
)
returns table(chunk_id uuid, document_id uuid, chunk_text text, score float)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  or_query tsquery := null;
  word_rec record;
  per_word tsquery;
begin
  -- Split on non-word characters; lowercase; drop tokens < 2 chars.
  -- The `\W+` split handles punctuation, whitespace, and any
  -- customer-typed weirdness uniformly.
  for word_rec in
    select w
    from regexp_split_to_table(lower(query_text), E'\\W+') as w
    where length(w) > 1
  loop
    -- plainto_tsquery on a single word gives one lexeme (or empty if
    -- the word is a stopword). Both are handled: we skip empties and
    -- OR-combine the rest.
    per_word := plainto_tsquery('english', word_rec.w);
    if per_word is null or per_word::text = '' then
      continue;
    end if;
    if or_query is null then
      or_query := per_word;
    else
      or_query := or_query || per_word;
    end if;
  end loop;

  -- All-stopwords or empty input — return nothing. Matches the
  -- previous behaviour (plainto_tsquery on stopword-only input also
  -- returned empty).
  if or_query is null then
    return;
  end if;

  return query
  select
    c.id as chunk_id,
    c.document_id,
    c.text as chunk_text,
    ts_rank(c.content_tsv, or_query)::float as score
  from chunks c
  where c.content_tsv @@ or_query
  order by ts_rank(c.content_tsv, or_query) desc
  limit match_count;
end;
$$;

-- Preserve the grants from migration 002. `create or replace` retains
-- existing grants, but re-granting is idempotent and explicit is
-- better than implicit — if a future migration drops-and-recreates
-- rather than replaces, the grants come along for the ride.
grant execute on function search_chunks_sparse(text, int) to anon, authenticated, service_role;
