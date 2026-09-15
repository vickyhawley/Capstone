# Runbook — corpus ingestion (GW-01)

Reads the product catalogue at `data/catalogue/products.csv` and the
prose guides at `data/guides/*.md`, chunks both, extracts typed
attributes for products with a matching schema (see
`packages/core/src/attribute-schemas/`), merges attributes into chunk
metadata, and persists to Supabase `documents` + `chunks`.

Idempotent by content hash: re-running against unchanged inputs is a
no-op. Content changes trigger a document update and full chunk
replacement.

## Prerequisites

- Supabase project with migration `001_initial_schema.sql` applied.
- An OpenAI account (any tier that supports `gpt-4o-mini` with
  structured outputs; that's the default paid plan).
- Env vars in `.env.local` at the repo root:

  ```
  SUPABASE_URL=https://<project-ref>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=<service role key>
  OPENAI_API_KEY=sk-...
  ```

  The service role key bypasses RLS. Keep it out of any client
  bundle — the ingest runs Node-side only.

## Run

From the repo root:

```
pnpm ingest
```

The command shells to `pnpm --filter @groundwork/ingestion ingest`,
which runs `tsx packages/ingestion/src/ingest-cli.ts`. Expect the
run to take one to three minutes for the ~400-product catalogue
(one LLM call per product with a matching schema).

Cost estimate: ~$0.0002 per extracted product at posted OpenAI
prices (see ADR-0004); a full 398-product extraction ≈ $0.08.

## Expected output

Stdout ends with an ingest report like:

```
Ingest report
=============
elapsed:                 78.4s

Documents
  inserted:              398
  updated:               0
  unchanged:             0

Attribute extraction
  products extracted:    120
  products skipped:      278 (no matching schema)
  extraction errors:     0
  attributes stored:     412
  attributes dropped:    3
    value-without-source-span: 1
    source-span-mismatch: 2

Colour agreement (ADR-0004 shipping gate ≥ 80%)
  62 / 70 = 88.6%
```

Read the report before closing GW-01. Two rules from ADR-0004
apply directly here:

1. **Hallucination drops non-zero → surface, do not silence.** The
   run does NOT exit non-zero on hallucination drops — the drops
   are the guardrail working. But GW-01 does not close without a
   review of what the extractor tried to do. If the count is
   surprising (say, >5% of stored attributes), investigate the
   prompt before shipping.
2. **Colour agreement below 80% → do not close.** GW-01's shipping
   gate is 80% agreement on the colour metafield sample. Below
   that, the options are: tighten the colour prompt in
   `packages/core/src/attribute-schemas/common.ts`, narrow the
   set of product types where extraction runs, or roll back
   extraction and re-open the ADR.

## Re-running against a fresh Supabase project

If starting from a clean project:

```
supabase db reset            # applies migrations from supabase/migrations/
pnpm ingest
```

The reset is destructive — only run against a scratch/dev branch.

## Verifying results

Quick sanity check (Supabase SQL editor):

```sql
select content_type, count(*) from documents group by 1;
select count(*) from chunks;
select
  metadata->>'type' as product_type,
  count(*) as products,
  count(*) filter (where metadata ? 'extracted_attributes') as with_attributes
from chunks
where document_id in (select id from documents where content_type = 'product')
group by 1
order by products desc;
```

Expect: `documents.content_type = 'product'` count matches the
catalogue product count (~398), `content_type = 'guide'` matches
the number of `.md` files in `data/guides/`, and every product
chunk has metadata populated.

## Troubleshooting

**"Missing required env var: X"** — the CLI aborts before doing
any work. Populate `.env.local` and rerun.

**Supabase 401 / RLS errors** — the service role key must be used
here, not the anon key. Anon key hits RLS which blocks
service-side inserts by default.

**OpenAI 429** — hit rate limits. gpt-4o-mini's default tier is
generous but a fresh account may be at 500 RPM. The runner
processes products sequentially and doesn't retry; if this
becomes a common failure, wrap the extractor in a small backoff.

**"Column extracted_attributes does not exist"** — you're looking
at the wrong column; extracted attributes live inside the
`metadata` jsonb, not as a top-level column. See the sanity-check
query above.
