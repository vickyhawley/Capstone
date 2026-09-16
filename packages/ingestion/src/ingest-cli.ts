/**
 * GW-01 ingest CLI.
 *
 * Reads the product catalogue and prose guides from `data/`, chunks
 * both types, runs the attribute extractor over products that have a
 * matching schema, merges extracted attributes into chunk metadata,
 * and persists documents + chunks to Supabase.
 *
 * Requires env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   — for `documents`/`chunks` writes
 *   OPENAI_API_KEY                             — for attribute extraction
 *
 * Idempotent by content hash: re-running against unchanged inputs is a
 * no-op. Content changes trigger a document update and chunk replacement.
 *
 * Emits an ingest report to stdout at end of run:
 *   - documents inserted / updated / unchanged
 *   - extraction: products with schema, attributes stored, attributes dropped
 *   - agreement rate: colour extractor value vs Shopify `Color` metafield
 *     on the products with the metafield populated (ADR-0004 §Validation).
 *
 * See docs/runbooks/ingest.md for how to run.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type AttributeSchema,
  type ExtractedAttribute,
  getAttributeSchema,
} from '@groundwork/core';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

import type { DroppedAttribute } from './attribute-extractor.js';
import { chunkGuide } from './guide-chunker.js';
import { embedTexts } from './openai-embedder.js';
import { extractAttributes } from './openai-extractor.js';
import { persistDocumentWithChunks } from './persistence.js';
import { type ShopifyRow, chunkProduct } from './product-chunker.js';
import type { ChunkInput, DocumentWithChunks } from './types.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const CATALOGUE_PATH = resolve(REPO_ROOT, 'data', 'catalogue', 'products.csv');
const GUIDES_DIR = resolve(REPO_ROOT, 'data', 'guides');

interface Env {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly OPENAI_API_KEY: string;
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
    OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
  };
}

// ---------- CSV parsing (minimal, tolerates quoted commas and embedded newlines) ----------

function parseCsv(text: string): { headers: readonly string[]; rows: readonly ShopifyRow[] } {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      current.push(field);
      field = '';
    } else if (ch === '\n') {
      current.push(field);
      rows.push(current);
      current = [];
      field = '';
    } else if (ch === '\r') {
      // skip
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    rows.push(current);
  }
  const [headerRow, ...dataRows] = rows;
  const headers = headerRow ?? [];
  const shaped: ShopifyRow[] = dataRows.map((row) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i] ?? ''] = row[i] ?? '';
    }
    return obj;
  });
  return { headers, rows: shaped };
}

// ---------- Compose extraction input from Shopify rows ----------

function composeExtractionInput(rows: readonly ShopifyRow[]): {
  title: string;
  description: string;
  variants: readonly string[];
} {
  const productRow = rows.find((row) => (row['Title'] ?? '').trim() !== '');
  if (!productRow) {
    throw new Error('composeExtractionInput: no product row');
  }
  const body = productRow['Body (HTML)'] ?? '';
  const description = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  const variants: string[] = [];
  for (const row of rows) {
    const value = (row['Option1 Value'] ?? '').trim();
    if (value !== '' && !variants.includes(value)) {
      variants.push(value);
    }
  }
  return {
    title: (productRow['Title'] ?? '').trim(),
    description,
    variants,
  };
}

// ---------- Group rows by product handle ----------

function groupByHandle(rows: readonly ShopifyRow[]): Map<string, ShopifyRow[]> {
  const groups = new Map<string, ShopifyRow[]>();
  for (const row of rows) {
    const handle = (row['Handle'] ?? '').trim();
    if (handle === '') {
      continue;
    }
    const existing = groups.get(handle);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(handle, [row]);
    }
  }
  return groups;
}

// ---------- Colour metafield ground truth ----------

const COLOUR_ALIASES: Record<string, string> = {
  navy: 'navy',
  'navy blue': 'navy',
  'dark blue': 'navy',
  tan: 'tan',
  beige: 'tan',
  camel: 'tan',
  black: 'black',
  brown: 'brown',
  chestnut: 'brown',
  grey: 'grey',
  gray: 'grey',
  white: 'white',
  red: 'red',
  green: 'green',
  pink: 'pink',
  blue: 'blue',
  purple: 'purple',
};

function normaliseColour(value: string): string {
  const lower = value.trim().toLowerCase();
  return COLOUR_ALIASES[lower] ?? lower;
}

function findColourColumn(headers: readonly string[]): string | null {
  return headers.find((h) => h.toLowerCase().includes('color-pattern')) ?? null;
}

function findMetafieldColour(rows: readonly ShopifyRow[], column: string | null): string | null {
  if (!column) {
    return null;
  }
  for (const row of rows) {
    const value = (row[column] ?? '').trim();
    if (value !== '') {
      return value;
    }
  }
  return null;
}

// ---------- Attribute merge into chunk metadata ----------

function mergeAttributesIntoChunks(
  chunks: readonly ChunkInput[],
  attributes: readonly ExtractedAttribute[],
): readonly ChunkInput[] {
  if (attributes.length === 0) {
    return chunks;
  }
  return chunks.map((chunk) => ({
    ...chunk,
    metadata: {
      ...chunk.metadata,
      extracted_attributes: attributes,
    },
  }));
}

function mergeEmbeddingsIntoChunks(
  chunks: readonly ChunkInput[],
  embeddings: readonly number[][],
): readonly ChunkInput[] {
  if (embeddings.length !== chunks.length) {
    throw new Error(
      `embedding count mismatch: got ${embeddings.length} embeddings for ${chunks.length} chunks`,
    );
  }
  return chunks.map((chunk, i) => {
    const embedding = embeddings[i];
    if (!embedding) {
      throw new Error(`embedding at index ${i} was missing after count check`);
    }
    return { ...chunk, embedding };
  });
}

// ---------- Guide ingestion ----------

interface IngestReport {
  documentsInserted: number;
  documentsUpdated: number;
  documentsForced: number;
  documentsUnchanged: number;
  productsExtracted: number;
  productsSkippedNoSchema: number;
  attributesStored: number;
  attributesDropped: number;
  dropsByReason: Map<string, number>;
  colourAgreementSample: number;
  colourAgreementMatches: number;
  extractionErrors: number;
  /**
   * Count of embeddings COMPUTED in this run — one per chunk of every
   * document processed, whether the persist path replaces chunks or
   * short-circuits on unchanged content. Counts work the ingest DID,
   * not work that landed.
   */
  chunksEmbedded: number;
  /**
   * Count of chunks PERSISTED — i.e. chunks that are in the `chunks`
   * table after the persist call, summed across every document
   * processed. For the "unchanged" persist path, this counts chunks
   * that were read back from an intact DB row set. For "inserted /
   * updated / forced" paths, it counts freshly-inserted chunks.
   *
   * Invariant on a healthy run: `chunksPersisted >= chunksEmbedded`.
   * `chunksEmbedded > chunksPersisted` is the shape of the GW-01
   * failure family (embeddings computed but not stored) and today's
   * det-IDs migration slip (chunks truncated, documents unchanged,
   * "unchanged" path returned zero — see ADR-0013 §Consequences,
   * "identity contract change requires --force").
   *
   * Sprint 1's Structural lesson recorded in ai-assisted-development.md:
   * "The ingest report knew about attribute extraction because the
   * extractor ran; it knew nothing about embeddings because nothing
   * about embeddings was in the pipeline the report described." Same
   * shape here: the report counted where the work was computed, not
   * where it landed. Splitting fixes the class rather than the
   * instance.
   */
  chunksPersisted: number;
  embeddingErrors: number;
}

function newReport(): IngestReport {
  return {
    documentsInserted: 0,
    documentsUpdated: 0,
    documentsForced: 0,
    documentsUnchanged: 0,
    productsExtracted: 0,
    productsSkippedNoSchema: 0,
    attributesStored: 0,
    attributesDropped: 0,
    dropsByReason: new Map(),
    colourAgreementSample: 0,
    colourAgreementMatches: 0,
    extractionErrors: 0,
    chunksEmbedded: 0,
    chunksPersisted: 0,
    embeddingErrors: 0,
  };
}

function tallyDrops(drops: readonly DroppedAttribute[], report: IngestReport): void {
  for (const drop of drops) {
    report.attributesDropped++;
    report.dropsByReason.set(drop.reason, (report.dropsByReason.get(drop.reason) ?? 0) + 1);
  }
}

function tallyAction(
  action: 'inserted' | 'updated' | 'unchanged' | 'forced',
  report: IngestReport,
): void {
  if (action === 'inserted') report.documentsInserted++;
  else if (action === 'updated') report.documentsUpdated++;
  else if (action === 'forced') report.documentsForced++;
  else report.documentsUnchanged++;
}

// ---------- CLI args ----------

function parseArgs(argv: readonly string[]): { force: boolean } {
  return { force: argv.includes('--force') };
}

// ---------- Main ----------

async function main(): Promise<void> {
  const env = readEnv();
  const { force } = parseArgs(process.argv.slice(2));
  const persistOptions = { force };

  if (force) {
    console.error('running with --force: chunk IDs may shift on unchanged documents.');
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  const report = newReport();
  const t0 = Date.now();

  // ---- Guides ----
  const guideFiles = readdirSync(GUIDES_DIR).filter((f) => f.endsWith('.md'));
  for (const guideFile of guideFiles) {
    const markdown = readFileSync(resolve(GUIDES_DIR, guideFile), 'utf-8');
    const slug = parse(guideFile).name;
    const docWithChunks = chunkGuide({ markdown, slug });

    let chunksWithEmbeddings: readonly ChunkInput[] = docWithChunks.chunks;
    try {
      const embeddings = await embedTexts(
        openai,
        docWithChunks.chunks.map((c) => c.text),
      );
      chunksWithEmbeddings = mergeEmbeddingsIntoChunks(docWithChunks.chunks, embeddings);
      report.chunksEmbedded += embeddings.length;
    } catch (error) {
      report.embeddingErrors++;
      console.error(
        `guide embedding failed for ${slug}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue; // don't persist a guide without embeddings — that's the gw-01 gap
    }

    const merged: DocumentWithChunks = {
      document: docWithChunks.document,
      chunks: chunksWithEmbeddings,
    };
    const result = await persistDocumentWithChunks(supabase, merged, persistOptions);
    tallyAction(result.action, report);
    report.chunksPersisted += result.chunkIds.length;
  }

  // ---- Products ----
  const csvText = readFileSync(CATALOGUE_PATH, 'utf-8');
  const { headers, rows } = parseCsv(csvText);
  const colourColumn = findColourColumn(headers);
  const groups = groupByHandle(rows);

  let productIndex = 0;
  for (const [handle, group] of groups) {
    productIndex++;
    const productRow = group.find((row) => (row['Title'] ?? '').trim() !== '');
    if (!productRow) {
      continue;
    }
    const productType = (productRow['Type'] ?? '').trim();
    const schema = productType ? getAttributeSchema(productType) : null;

    // Chunk (always).
    const docWithChunks = chunkProduct(group);

    // Extract (only if a schema matches the product type).
    let attributes: readonly ExtractedAttribute[] = [];
    if (schema) {
      try {
        const extractionInput = composeExtractionInput(group);
        const extraction = await extractAttributes(openai, extractionInput, schema);
        attributes = extraction.attributes;
        report.productsExtracted++;
        report.attributesStored += extraction.attributes.filter((a) => a.value !== null).length;
        tallyDrops(extraction.drops, report);

        // Colour agreement check.
        const metafieldColour = findMetafieldColour(group, colourColumn);
        if (metafieldColour) {
          const extractedColour = extraction.attributes.find((a) => a.key === 'colour');
          if (extractedColour && typeof extractedColour.value === 'string') {
            report.colourAgreementSample++;
            if (normaliseColour(extractedColour.value) === normaliseColour(metafieldColour)) {
              report.colourAgreementMatches++;
            }
          }
        }
      } catch (error) {
        report.extractionErrors++;
        console.error(
          `[${productIndex}/${groups.size}] extraction failed for ${handle}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      report.productsSkippedNoSchema++;
    }

    // Attach attributes into chunk metadata.
    const chunksWithAttributes = mergeAttributesIntoChunks(docWithChunks.chunks, attributes);

    // Embed. Fail loudly rather than persist a product without embeddings —
    // that is exactly the GW-01 gap the fold-in exists to close.
    let chunksReady: readonly ChunkInput[];
    try {
      const embeddings = await embedTexts(
        openai,
        chunksWithAttributes.map((c) => c.text),
      );
      chunksReady = mergeEmbeddingsIntoChunks(chunksWithAttributes, embeddings);
      report.chunksEmbedded += embeddings.length;
    } catch (error) {
      report.embeddingErrors++;
      console.error(
        `[${productIndex}/${groups.size}] embedding failed for ${handle}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    // Persist.
    const merged: DocumentWithChunks = {
      document: docWithChunks.document,
      chunks: chunksReady,
    };
    const result = await persistDocumentWithChunks(supabase, merged, persistOptions);
    tallyAction(result.action, report);
    report.chunksPersisted += result.chunkIds.length;

    if (productIndex % 25 === 0) {
      console.error(`[${productIndex}/${groups.size}] progressing…`);
    }
  }

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  // ---- Report ----
  console.log('');
  console.log('Ingest report');
  console.log('=============');
  console.log(`elapsed:                 ${elapsedSec}s`);
  console.log('');
  console.log('Documents');
  console.log(`  inserted:              ${report.documentsInserted}`);
  console.log(`  updated:               ${report.documentsUpdated}`);
  console.log(`  forced:                ${report.documentsForced}`);
  console.log(`  unchanged:             ${report.documentsUnchanged}`);
  console.log('');
  console.log('Chunks (ADR-0001 embeddings + ADR-0013 deterministic IDs)');
  console.log(`  embedded (computed):   ${report.chunksEmbedded}`);
  console.log(`  persisted (in DB):     ${report.chunksPersisted}`);
  console.log(`  embedding errors:      ${report.embeddingErrors}`);
  // Alarm when embedded > persisted. This is the shape of the GW-01
  // failure family (embeddings computed but not stored) and the
  // det-IDs migration slip (chunks truncated + docs unchanged made
  // the persist path short-circuit). The report always showed
  // "embedded: N" — until Sprint 3 2026-09-16 it did not show
  // "persisted: 0" alongside it, so the divergence was silent.
  if (report.chunksEmbedded > report.chunksPersisted) {
    const orphaned = report.chunksEmbedded - report.chunksPersisted;
    console.log('');
    console.log(`  CRITICAL: ${orphaned} chunk embedding(s) computed but not persisted.`);
    console.log(
      '  This is the shape of the GW-01 failure family — work landed in a counter, not in the DB.',
    );
    console.log('  Likely cause: chunks table was cleared (truncate, migration) while');
    console.log("  documents' content_hash values were unchanged, so persistence short-");
    console.log('  circuited via the "unchanged" branch and never re-inserted.');
    console.log('  Fix: rerun with `pnpm ingest -- --force`. See ADR-0013 §Consequences.');
  }
  console.log('');
  console.log('Attribute extraction');
  console.log(`  products extracted:    ${report.productsExtracted}`);
  console.log(`  products skipped:      ${report.productsSkippedNoSchema} (no matching schema)`);
  console.log(`  extraction errors:     ${report.extractionErrors}`);
  console.log(`  attributes stored:     ${report.attributesStored}`);
  console.log(`  attributes dropped:    ${report.attributesDropped}`);
  for (const [reason, count] of report.dropsByReason) {
    console.log(`    ${reason}: ${count}`);
  }
  console.log('');
  console.log('Colour agreement (ADR-0004 shipping gate ≥ 80%)');
  if (report.colourAgreementSample > 0) {
    const pct = (100 * report.colourAgreementMatches) / report.colourAgreementSample;
    console.log(
      `  ${report.colourAgreementMatches} / ${report.colourAgreementSample} = ${pct.toFixed(1)}%`,
    );
    if (pct < 80) {
      console.log('  BELOW SHIPPING THRESHOLD — see ADR-0004.');
    }
  } else {
    console.log(
      '  no sample (either colour column not present or no metafield-populated products in extraction set)',
    );
  }

  // Fail non-zero if the hallucination guardrail caught anything —
  // ADR-0004: "if that count is non-zero, GW-01 does not close".
  const hallucinationDrops =
    (report.dropsByReason.get('value-without-source-span') ?? 0) +
    (report.dropsByReason.get('source-span-mismatch') ?? 0);
  if (hallucinationDrops > 0) {
    console.log('');
    console.log(
      `Hallucination drops non-zero (${hallucinationDrops}) — surface this to review before closing GW-01 (ADR-0004 §failure mode).`,
    );
    // Note: we do NOT exit non-zero — the drops are the guardrail
    // working. The ADR says surface, not fail. Failing here would
    // prevent the ingest report from being read in CI logs.
  }

  // DO exit non-zero if the embed-vs-persist divergence fired. This
  // is a genuine "the pipeline claims to have done X but X is not in
  // the DB" failure — every downstream consumer will silently score
  // wrong if the operator misses the stdout warning above. Exit code
  // makes it script-visible.
  if (report.chunksEmbedded > report.chunksPersisted) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
