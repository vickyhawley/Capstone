import { describe, expect, it } from 'vitest';

import { type ShopifyRow, chunkProduct } from './product-chunker.js';

/**
 * Test fixtures are hand-authored to keep the snapshots readable.
 * When the composition of a chunk body changes deliberately, the
 * inline snapshot below is the diff you review. Do not regenerate
 * blindly — check the diff means what the change intended.
 */

const feedProductRow: ShopifyRow = {
  Handle: 'baileys-no-8-with-turmeric',
  Title: 'Baileys No 8 With Turmeric',
  'Body (HTML)':
    '<p>A high-fibre conditioning mix with added turmeric for joint support.</p>' +
    '<p>Feeding rate: 300 g per 100 kg horse per day.</p>',
  Vendor: 'Baileys',
  Type: 'Feed',
  Tags: 'local-delivery-only, feed, conditioning',
  'Option1 Name': 'Size',
  'Option1 Value': '20 kg',
  'Variant SKU': 'BAI-N8-TURM-20',
  'Variant Price': '14.50',
};

const feedVariantRow: ShopifyRow = {
  Handle: 'baileys-no-8-with-turmeric',
  Title: '',
  'Body (HTML)': '',
  Vendor: '',
  Type: '',
  Tags: '',
  'Option1 Name': 'Size',
  'Option1 Value': '25 kg',
  'Variant SKU': 'BAI-N8-TURM-25',
  'Variant Price': '17.50',
};

describe('chunkProduct', () => {
  it('throws on empty rows', () => {
    expect(() => chunkProduct([])).toThrow(/empty rows/);
  });

  it('throws when no row has a non-empty Title', () => {
    expect(() => chunkProduct([{ ...feedVariantRow }])).toThrow(/no product row/);
  });

  it('emits one document and one chunk (not one per variant)', () => {
    const result = chunkProduct([feedProductRow, feedVariantRow]);
    expect(result.chunks).toHaveLength(1);
    expect(result.document.contentType).toBe('product');
  });

  it('populates document metadata from the product row', () => {
    const result = chunkProduct([feedProductRow, feedVariantRow]);
    expect(result.document.sourceRef).toBe('baileys-no-8-with-turmeric');
    expect(result.document.title).toBe('Baileys No 8 With Turmeric');
    expect(result.document.metadata).toMatchObject({
      handle: 'baileys-no-8-with-turmeric',
      vendor: 'Baileys',
      type: 'Feed',
      tags: ['local-delivery-only', 'feed', 'conditioning'],
    });
  });

  it('populates chunk metadata with price range and delivery flag', () => {
    const result = chunkProduct([feedProductRow, feedVariantRow]);
    expect(result.chunks[0]?.metadata).toMatchObject({
      price_min: 14.5,
      price_max: 17.5,
      variant_count: 2,
      local_delivery_only: true,
    });
  });

  it('flags local_delivery_only false when the tag is absent', () => {
    const row: ShopifyRow = {
      ...feedProductRow,
      Tags: 'feed, conditioning',
    };
    const result = chunkProduct([row]);
    expect(result.chunks[0]?.metadata['local_delivery_only']).toBe(false);
  });

  it('strips HTML from the description', () => {
    const result = chunkProduct([feedProductRow]);
    expect(result.chunks[0]?.text).not.toContain('<p>');
    expect(result.chunks[0]?.text).toContain('joint support');
  });

  it('renders the composed chunk body deterministically (snapshot)', () => {
    const result = chunkProduct([feedProductRow, feedVariantRow]);
    expect(result.chunks[0]?.text).toMatchInlineSnapshot(`
      "# Baileys No 8 With Turmeric
      Vendor: Baileys
      Type: Feed
      Tags: local-delivery-only, feed, conditioning

      A high-fibre conditioning mix with added turmeric for joint support. Feeding rate: 300 g per 100 kg horse per day.

      ## Variants

      Size | SKU | Price
      - | - | -
      20 kg | BAI-N8-TURM-20 | £14.50
      25 kg | BAI-N8-TURM-25 | £17.50"
    `);
  });

  it('produces stable content hashes across identical inputs', () => {
    const a = chunkProduct([feedProductRow, feedVariantRow]);
    const b = chunkProduct([feedProductRow, feedVariantRow]);
    expect(a.document.contentHash).toBe(b.document.contentHash);
    expect(a.document.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('skips variant rows with no price', () => {
    const noPriceRow: ShopifyRow = { ...feedVariantRow, 'Variant Price': '' };
    const result = chunkProduct([feedProductRow, noPriceRow]);
    expect(result.chunks[0]?.metadata['variant_count']).toBe(1);
  });
});
