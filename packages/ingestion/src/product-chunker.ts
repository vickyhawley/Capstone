/**
 * Product chunker. Takes a group of Shopify CSV rows for one product
 * (one product row plus zero or more variant-only rows) and emits a
 * single document + single chunk. One chunk per product, not per
 * variant — see ADR-0003 for why.
 *
 * The composed chunk body is deterministic (fed only by the input
 * rows) and its shape is regression-protected by inline snapshot
 * tests in product-chunker.test.ts. Changes to the composition are
 * intentional when a snapshot diff appears in review.
 */

import { createHash } from 'node:crypto';

import type { VariantRow } from './render-variant-table.js';
import { renderVariantTable } from './render-variant-table.js';
import type { ChunkInput, DocumentInput, DocumentWithChunks } from './types.js';

export type ShopifyRow = Readonly<Record<string, string>>;

const LOCAL_DELIVERY_TAG = 'local-delivery-only';

/**
 * Token-count heuristic: roughly 4 characters per token for English
 * prose. Not a real tokeniser — real counting happens at embed time
 * against the embedding model's tokeniser. This estimate is only used
 * for chunk-size decisions where being within ~25% is fine.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePrice(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function extractVariants(rows: readonly ShopifyRow[]): readonly VariantRow[] {
  const variants: VariantRow[] = [];
  for (const row of rows) {
    const price = parsePrice(row['Variant Price'] ?? '');
    if (price === null) {
      continue;
    }
    variants.push({
      optionName: (row['Option1 Name'] ?? '').trim() || 'Variant',
      optionValue: (row['Option1 Value'] ?? '').trim(),
      sku: (row['Variant SKU'] ?? '').trim() || 'NO-SKU',
      price,
    });
  }
  return variants;
}

export function chunkProduct(rows: readonly ShopifyRow[]): DocumentWithChunks {
  if (rows.length === 0) {
    throw new Error('chunkProduct called with empty rows');
  }
  const productRow = rows.find((row) => (row['Title'] ?? '').trim() !== '');
  if (!productRow) {
    throw new Error('chunkProduct called with rows containing no product row (non-empty Title)');
  }

  const handle = (productRow['Handle'] ?? '').trim();
  const title = (productRow['Title'] ?? '').trim();
  const vendor = (productRow['Vendor'] ?? '').trim();
  const type = (productRow['Type'] ?? '').trim();
  const tagsRaw = (productRow['Tags'] ?? '').trim();
  const tags = tagsRaw === '' ? [] : tagsRaw.split(',').map((tag) => tag.trim());
  const bodyHtml = productRow['Body (HTML)'] ?? '';
  const description = stripHtml(bodyHtml);

  const variants = extractVariants(rows);
  // extractVariants already filters null prices, but VariantRow's shape
  // keeps price nullable for renderers that need the em-dash case.
  // Narrow here so Math.min/max is typed safely.
  const prices = variants.map((v) => v.price).filter((p): p is number => p !== null);
  const priceMin = prices.length > 0 ? Math.min(...prices) : null;
  const priceMax = prices.length > 0 ? Math.max(...prices) : null;
  const localDeliveryOnly = tags.some((tag) => tag.toLowerCase() === LOCAL_DELIVERY_TAG);

  const bodyParts: string[] = [`# ${title}`];
  if (vendor) bodyParts.push(`Vendor: ${vendor}`);
  if (type) bodyParts.push(`Type: ${type}`);
  if (tags.length > 0) bodyParts.push(`Tags: ${tags.join(', ')}`);
  if (description) bodyParts.push('', description);
  if (variants.length > 0) {
    bodyParts.push('', '## Variants', '', renderVariantTable(variants));
  }
  const text = bodyParts.join('\n');

  const chunkMetadata: Readonly<Record<string, unknown>> = {
    handle,
    vendor,
    type,
    tags,
    price_min: priceMin,
    price_max: priceMax,
    variant_count: variants.length,
    local_delivery_only: localDeliveryOnly,
  };

  const document: DocumentInput = {
    source: 'shopify',
    sourceRef: handle,
    title,
    url: null,
    contentType: 'product',
    language: 'en',
    contentHash: sha256(text),
    metadata: {
      handle,
      vendor,
      type,
      tags,
    },
  };

  const chunk: ChunkInput = {
    ordinal: 0,
    parentOrdinal: null,
    text,
    tokenCount: estimateTokens(text),
    metadata: chunkMetadata,
  };

  return { document, chunks: [chunk] };
}
