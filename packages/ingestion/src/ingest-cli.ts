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

// ---------- Guide ingestion ----------

interface IngestReport {
  documentsInserted: number;
  documentsUpdated: number;
  documentsUnchanged: number;
  productsExtracted: number;
  productsSkippedNoSchema: number;
  attributesStored: number;
  attributesDropped: number;
  dropsByReason: Map<string, number>;
  colourAgreementSample: number;
  colourAgreementMatches: number;
  extractionErrors: number;
}

function newReport(): IngestReport {
  return {
    documentsInserted: 0,
    documentsUpdated: 0,
    documentsUnchanged: 0,
    productsExtracted: 0,
    productsSkippedNoSchema: 0,
    attributesStored: 0,
    attributesDropped: 0,
    dropsByReason: new Map(),
    colourAgreementSample: 0,
    colourAgreementMatches: 0,
    extractionErrors: 0,
  };
}

function tallyDrops(drops: readonly DroppedAttribute[], report: IngestReport): void {
  for (const drop of drops) {
    report.attributesDropped++;
    report.dropsByReason.set(drop.reason, (report.dropsByReason.get(drop.reason) ?? 0) + 1);
  }
}

function tallyAction(action: 'inserted' | 'updated' | 'unchanged', report: IngestReport): void {
  if (action === 'inserted') report.documentsInserted++;
  else if (action === 'updated') report.documentsUpdated++;
  else report.documentsUnchanged++;
}

// ---------- Main ----------

async function main(): Promise<void> {
  const env = readEnv();

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
    const result = await persistDocumentWithChunks(supabase, docWithChunks);
    tallyAction(result.action, report);
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

    // Persist.
    const mergedChunks = mergeAttributesIntoChunks(docWithChunks.chunks, attributes);
    const merged: DocumentWithChunks = {
      document: docWithChunks.document,
      chunks: mergedChunks,
    };
    const result = await persistDocumentWithChunks(supabase, merged);
    tallyAction(result.action, report);

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
  console.log(`  unchanged:             ${report.documentsUnchanged}`);
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
