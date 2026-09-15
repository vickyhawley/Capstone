/**
 * One-off backfill for chunk embeddings.
 *
 * Migration 001 declared `chunks.embedding vector(1536)` and an HNSW
 * index, but the GW-01 ingest pipeline never populated the column —
 * the extractor calls OpenAI for attribute extraction, not for
 * embeddings. This script closes that gap so dense retrieval has
 * something to search.
 *
 * Idempotent: only chunks with `embedding IS NULL` get processed. A
 * second run against an already-backfilled table is a no-op.
 *
 * Rate limits and cost:
 * - text-embedding-3-small at $0.02 per 1M input tokens.
 * - ~417 chunks × ~200 tokens ≈ 83k tokens ≈ $0.002 per full run.
 * - Batched at 50 chunks per API call to keep round-trips down.
 *
 * See ADR-0001 for the model commitment and the migration-cost note
 * on what changing model would entail.
 */

import { EMBEDDING_DIM, EMBEDDING_MODEL } from '@groundwork/adapters';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

interface Env {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly OPENAI_API_KEY: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value === '') {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return value;
}

function readEnv(): Env {
  return {
    SUPABASE_URL: requireEnv('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
  };
}

const BATCH_SIZE = 50;

async function main(): Promise<void> {
  const env = readEnv();
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  // Fetch all chunks with a null embedding. Paginate — supabase-js
  // caps at 1000 by default which is fine at Sprint 1 scale.
  const { data: chunks, error } = await supabase
    .from('chunks')
    .select('id, text')
    .is('embedding', null)
    .limit(2000);
  if (error) {
    throw new Error(`chunk read failed: ${error.message}`);
  }
  const rows = (chunks ?? []) as { id: string; text: string }[];
  console.error(`Found ${rows.length} chunks with NULL embedding.`);

  if (rows.length === 0) {
    console.error('Nothing to backfill.');
    return;
  }

  let processed = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch.map((r) => r.text),
    });
    if (response.data.length !== batch.length) {
      throw new Error(`expected ${batch.length} embeddings, got ${response.data.length}`);
    }
    for (let j = 0; j < batch.length; j++) {
      const row = batch[j];
      const embedding = response.data[j]?.embedding;
      if (!row || !embedding || embedding.length !== EMBEDDING_DIM) {
        throw new Error(`embedding dim mismatch for row ${row?.id ?? '?'}`);
      }
      const { error: updateError } = await supabase
        .from('chunks')
        .update({ embedding: embedding as unknown as string })
        .eq('id', row.id);
      if (updateError) {
        throw new Error(`update failed for ${row.id}: ${updateError.message}`);
      }
    }
    processed += batch.length;
    console.error(`  processed ${processed}/${rows.length}`);
  }

  console.error('Backfill complete.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
