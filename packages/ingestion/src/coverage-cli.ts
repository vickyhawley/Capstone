/**
 * Per-attribute-key coverage report over the extracted-attribute data
 * in Supabase.
 *
 * Purpose: `pnpm ingest`'s summary reports totals ("297 attributes
 * stored across 120 products"), but 2.5 attributes-per-product on
 * schemas of 5–6 attributes is ambiguous — it could mean descriptions
 * genuinely lack the facts (confirming ADR-0003's premise) OR the
 * extractor hedging by returning null when the fact IS in the source.
 * This tool disaggregates: for each (product_type, attribute_key),
 * count how many products got a non-null value vs null vs no record.
 *
 * Read-only. No writes to Supabase. Reruns produce the same numbers
 * against unchanged data.
 *
 * Companion to `scripts/profile_catalogue.py` which measures the same
 * kind of coverage against the raw CSV descriptions before extraction.
 * Together they answer "did extraction lift the coverage vs prose-only?"
 */

import { listAttributeSchemas } from '@groundwork/core';
import { createClient } from '@supabase/supabase-js';

interface Env {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value === '') {
    console.error(`Missing required env var: ${name}`);
    console.error('See docs/runbooks/ingest.md.');
    process.exit(2);
  }
  return value;
}

function readEnv(): Env {
  return {
    SUPABASE_URL: requireEnv('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  };
}

interface ExtractedAttribute {
  readonly key: string;
  readonly value: string | number | boolean | null;
}

interface ChunkRow {
  readonly metadata: {
    readonly type?: string;
    readonly extracted_attributes?: readonly ExtractedAttribute[];
  };
  readonly document?: { readonly content_type?: string };
}

async function main(): Promise<void> {
  const env = readEnv();
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Inner-join filter on documents.content_type. An earlier draft used
  // documents.id .in(...) but 398 UUIDs blows the URL length limit on
  // the PostgREST GET; the join expresses the same filter without
  // materialising every ID in the query string. supabase-js pages at
  // 1000 rows by default, so this is safe up to ~1000 product chunks.
  const { data: chunks, error: chunkError } = await supabase
    .from('chunks')
    .select('metadata, document:documents!inner(content_type)')
    .eq('documents.content_type', 'product')
    .limit(2000);
  if (chunkError) {
    throw new Error(`chunk read failed: ${chunkError.message}`);
  }

  // Bucket chunks by product type. Each product has one chunk, so the
  // count of chunks per type equals the count of products per type.
  const rows = (chunks ?? []) as ChunkRow[];
  const byType: Map<string, ChunkRow[]> = new Map();
  for (const row of rows) {
    const type = row.metadata?.type ?? '(untyped)';
    const bucket = byType.get(type);
    if (bucket) {
      bucket.push(row);
    } else {
      byType.set(type, [row]);
    }
  }

  console.log('Per-attribute coverage — chunks in Supabase');
  console.log('===========================================');
  console.log('');

  for (const schema of listAttributeSchemas()) {
    const bucket = byType.get(schema.productType) ?? [];
    console.log(
      `${schema.productType}  (${bucket.length} product${bucket.length === 1 ? '' : 's'})`,
    );
    if (bucket.length === 0) {
      console.log('  (no products of this type in the store)');
      console.log('');
      continue;
    }
    for (const attr of schema.attributes) {
      let nonNull = 0;
      let nullValue = 0;
      let missing = 0;
      for (const row of bucket) {
        const found = row.metadata?.extracted_attributes?.find((a) => a.key === attr.key);
        if (!found) {
          missing++;
        } else if (found.value === null) {
          nullValue++;
        } else {
          nonNull++;
        }
      }
      const pct = ((100 * nonNull) / bucket.length).toFixed(1);
      const missingClause = missing > 0 ? `, ${missing} missing (no record)` : '';
      console.log(
        `  ${attr.key.padEnd(38)} ${String(nonNull).padStart(3)} / ${bucket.length} = ${pct.padStart(5)}%   (null: ${nullValue}${missingClause})`,
      );
    }
    console.log('');
  }

  const skippedTypes = [...byType.keys()].filter(
    (t) => !listAttributeSchemas().some((s) => s.productType === t),
  );
  if (skippedTypes.length > 0) {
    console.log('Skipped types (no schema):');
    for (const type of skippedTypes.sort()) {
      const bucket = byType.get(type) ?? [];
      console.log(`  ${type || '(empty)'}: ${bucket.length} products`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
