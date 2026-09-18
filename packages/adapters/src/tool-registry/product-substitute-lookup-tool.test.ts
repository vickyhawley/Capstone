/**
 * Unit tests for ProductSubstituteLookupTool. GW-19 / ADR-0005
 * addendum 2026-09-18 (revised at smoke time — see sprint-log GW-19
 * close-out for what changed).
 *
 * Covers: Path B anchor (top-1 metadata), inclusion of the anchor as
 * a substitute candidate (the top-1 IS the closest in-corpus product
 * when stock_lookup returned non-exact), type-only filter (primary
 * attribute is observability, not a filter — smoke on case 022
 * showed ADR-0004 extraction quality can't yet support a filter),
 * ordering (same-vendor beats cross-vendor, then cosine, then chunk-
 * id), and the honest fall-through paths (exact → skip; empty
 * retrieval → note; anchor missing type/handle → note).
 */

import type { RetrievalQuery, RetrievedChunk, Retriever } from '@groundwork/core';
import { describe, expect, it } from 'vitest';

import {
  ProductSubstituteLookupTool,
  type SubstituteLookupResult,
} from './product-substitute-lookup-tool.js';

function makeRetriever(results: readonly RetrievedChunk[]): Retriever {
  return {
    async retrieve(_query: RetrievalQuery): Promise<readonly RetrievedChunk[]> {
      return results;
    },
  };
}

function makeChunk(overrides: Partial<RetrievedChunk> & { score: number }): RetrievedChunk {
  return {
    chunkId: overrides.chunkId ?? 'chunk-default',
    documentId: overrides.documentId ?? 'doc-default',
    text: overrides.text ?? 'some product content',
    score: overrides.score,
    metadata: overrides.metadata ?? {},
  };
}

function haylageChunk(opts: {
  chunkId: string;
  handle: string;
  vendor: string;
  cutType: string | null;
  score: number;
  priceMin?: number;
  priceMax?: number;
  title?: string;
}): RetrievedChunk {
  return makeChunk({
    chunkId: opts.chunkId,
    score: opts.score,
    metadata: {
      type: 'Haylage',
      handle: opts.handle,
      vendor: opts.vendor,
      title: opts.title,
      price_min: opts.priceMin,
      price_max: opts.priceMax,
      extracted_attributes: [{ key: 'cut_type', value: opts.cutType, confidence: 1 }],
    },
  });
}

describe('ProductSubstituteLookupTool', () => {
  it('advertises product.substitute_lookup with productQuery + stockStatus required', () => {
    const tool = new ProductSubstituteLookupTool(makeRetriever([]));
    const defs = tool.list();
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('product.substitute_lookup');
    const schema = defs[0]?.schema as { required?: string[] };
    expect(schema.required).toContain('productQuery');
    expect(schema.required).toContain('stockStatus');
  });

  it('short-circuits when stockStatus is exact — no substitutes, note explains', async () => {
    // ADR-0005 addendum: when the queried product is in stock,
    // substitute reasoning would confuse the customer answer. The
    // tool doesn't invoke retrieval at all in this path.
    const tool = new ProductSubstituteLookupTool(makeRetriever([]));
    const result = await tool.invoke({
      name: 'product.substitute_lookup',
      args: { productQuery: 'anything', stockStatus: 'exact' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as SubstituteLookupResult;
    expect(value.substitutes).toEqual([]);
    expect(value.anchor).toBeNull();
    expect(value.note).toContain('exact');
  });

  it('returns the anchor as the primary substitute (case-022/044 shape)', async () => {
    // When stock_lookup returns non-exact, the top-1 dense hit IS
    // the closest in-corpus product — that IS the substitute the
    // shop would recommend. The tool includes it in the returned
    // list rather than pivoting away from it.
    const tool = new ProductSubstituteLookupTool(
      makeRetriever([
        haylageChunk({
          chunkId: 'anchor',
          handle: 'horsehage-timothy',
          vendor: 'Scarterfield',
          cutType: 'timothy',
          score: 0.644,
          title: 'HorseHage Timothy',
        }),
      ]),
    );
    const result = await tool.invoke({
      name: 'product.substitute_lookup',
      args: { productQuery: 'Western Timothy Haylage', stockStatus: 'orderable' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as SubstituteLookupResult;
    expect(value.substitutes).toHaveLength(1);
    expect(value.substitutes[0]?.handle).toBe('horsehage-timothy');
    expect(value.substitutes[0]?.relationLabel).toBe('substitute');
    expect(value.anchor?.handle).toBe('horsehage-timothy');
    expect(value.anchor?.type).toBe('Haylage');
    expect(value.anchor?.primaryAttribute).toEqual({ key: 'cut_type', value: 'timothy' });
  });

  it('includes multiple same-type candidates when retrieval returns them', async () => {
    // Retriever returns top-1 = HorseHage Timothy, top-2 = Burley
    // Bale Timothy. Both share Haylage type. Both come back.
    const tool = new ProductSubstituteLookupTool(
      makeRetriever([
        haylageChunk({
          chunkId: 'anchor',
          handle: 'horsehage-timothy',
          vendor: 'Scarterfield',
          cutType: 'timothy',
          score: 0.644,
        }),
        haylageChunk({
          chunkId: 'sub-1',
          handle: 'burley-bale-timothy',
          vendor: 'Burley Bale Ltd',
          cutType: 'timothy',
          score: 0.5,
        }),
      ]),
    );
    const result = await tool.invoke({
      name: 'product.substitute_lookup',
      args: { productQuery: 'timothy hay', stockStatus: 'orderable' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as SubstituteLookupResult;
    // Same-vendor beats cross-vendor: anchor's vendor is
    // Scarterfield, and anchor is the same-vendor candidate.
    expect(value.substitutes.map((s) => s.handle)).toEqual([
      'horsehage-timothy',
      'burley-bale-timothy',
    ]);
  });

  it('drops candidates whose type differs from the anchor', async () => {
    const tool = new ProductSubstituteLookupTool(
      makeRetriever([
        haylageChunk({
          chunkId: 'anchor',
          handle: 'horsehage-timothy',
          vendor: 'Scarterfield',
          cutType: 'timothy',
          score: 0.6,
        }),
        makeChunk({
          chunkId: 'wrong-type',
          score: 0.55,
          metadata: {
            type: 'Feed',
            handle: 'random-feed',
            vendor: 'Baileys',
            extracted_attributes: [{ key: 'form', value: 'mix' }],
          },
        }),
      ]),
    );
    const result = await tool.invoke({
      name: 'product.substitute_lookup',
      args: { productQuery: 'timothy hay', stockStatus: 'orderable' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Anchor comes back; wrong-type candidate is dropped.
    const value = result.value as SubstituteLookupResult;
    expect(value.substitutes.map((s) => s.handle)).toEqual(['horsehage-timothy']);
  });

  it('drops candidates missing type or handle metadata (guide chunks etc.)', async () => {
    // A guide chunk (no `type` metadata) that slipped past the
    // retriever's content_type filter. Rule requires both type +
    // handle before considering a chunk as a substitute candidate.
    const tool = new ProductSubstituteLookupTool(
      makeRetriever([
        haylageChunk({
          chunkId: 'anchor',
          handle: 'horsehage-timothy',
          vendor: 'Scarterfield',
          cutType: 'timothy',
          score: 0.6,
        }),
        makeChunk({
          chunkId: 'guide-chunk',
          score: 0.55,
          metadata: {}, // no type, no handle
        }),
      ]),
    );
    const result = await tool.invoke({
      name: 'product.substitute_lookup',
      args: { productQuery: 'timothy hay', stockStatus: 'orderable' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as SubstituteLookupResult).substitutes.map((s) => s.handle)).toEqual([
      'horsehage-timothy',
    ]);
  });

  it('reports primary-attribute mismatch as observability but does NOT filter on it', async () => {
    // Anchor is Timothy Haylage; candidate is Ryegrass Haylage.
    // Same type. Under the revised design (post-2026-09-18 smoke),
    // the primary attribute is observability-only — the candidate
    // comes back with matches: false rather than being dropped.
    // Retriever-quality issue if a wrong-species result surfaces;
    // fix at the retriever, not by dropping candidates the tool
    // can't confidently reject.
    const tool = new ProductSubstituteLookupTool(
      makeRetriever([
        haylageChunk({
          chunkId: 'anchor',
          handle: 'horsehage-timothy',
          vendor: 'Scarterfield',
          cutType: 'timothy',
          score: 0.6,
        }),
        haylageChunk({
          chunkId: 'wrong-cut',
          handle: 'horsehage-ryegrass',
          vendor: 'Scarterfield',
          cutType: 'ryegrass',
          score: 0.55,
        }),
      ]),
    );
    const result = await tool.invoke({
      name: 'product.substitute_lookup',
      args: { productQuery: 'timothy hay', stockStatus: 'orderable' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as SubstituteLookupResult;
    expect(value.substitutes.map((s) => s.handle)).toEqual([
      'horsehage-timothy',
      'horsehage-ryegrass',
    ]);
    // Observability: ryegrass candidate reports the mismatch.
    const ryegrass = value.substitutes.find((s) => s.handle === 'horsehage-ryegrass');
    expect(ryegrass?.attributeAgreement[0]).toMatchObject({
      key: 'cut_type',
      queryValue: 'timothy',
      candidateValue: 'ryegrass',
      matches: false,
      primary: true,
    });
  });

  it('orders same-vendor before cross-vendor', async () => {
    // Anchor: Scarterfield HorseHage Timothy. Two candidates:
    // higher-cosine cross-vendor, lower-cosine same-vendor. Same-
    // vendor wins the second slot (anchor is first as same-vendor
    // by definition).
    const tool = new ProductSubstituteLookupTool(
      makeRetriever([
        haylageChunk({
          chunkId: 'anchor',
          handle: 'horsehage-timothy',
          vendor: 'Scarterfield',
          cutType: 'timothy',
          score: 0.6,
        }),
        haylageChunk({
          chunkId: 'cross-vendor',
          handle: 'burley-bale-timothy',
          vendor: 'Burley Bale Ltd',
          cutType: 'timothy',
          score: 0.58, // higher cosine but cross-vendor
        }),
        haylageChunk({
          chunkId: 'same-vendor',
          handle: 'horsehage-timothy-purple',
          vendor: 'Scarterfield',
          cutType: 'timothy',
          score: 0.5, // lower cosine but same-vendor
        }),
      ]),
    );
    const result = await tool.invoke({
      name: 'product.substitute_lookup',
      args: { productQuery: 'timothy hay', stockStatus: 'orderable' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as SubstituteLookupResult;
    // Anchor (same-vendor, cosine 0.6) first, then same-vendor
    // (0.5), then cross-vendor (0.58).
    expect(value.substitutes.map((s) => s.handle)).toEqual([
      'horsehage-timothy',
      'horsehage-timothy-purple',
      'burley-bale-timothy',
    ]);
  });

  it('caps at 3 substitutes even when more candidates match', async () => {
    const anchor = haylageChunk({
      chunkId: 'anchor',
      handle: 'anchor-handle',
      vendor: 'X',
      cutType: 'timothy',
      score: 0.6,
    });
    const many: readonly RetrievedChunk[] = [
      anchor,
      ...Array.from({ length: 5 }, (_, i) =>
        haylageChunk({
          chunkId: `sub-${i}`,
          handle: `sub-${i}`,
          vendor: `V${i}`,
          cutType: 'timothy',
          score: 0.5 - i * 0.01,
        }),
      ),
    ];
    const tool = new ProductSubstituteLookupTool(makeRetriever(many));
    const result = await tool.invoke({
      name: 'product.substitute_lookup',
      args: { productQuery: 'timothy hay', stockStatus: 'orderable' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as SubstituteLookupResult).substitutes).toHaveLength(3);
  });

  describe('honest fall-throughs', () => {
    it("returns null anchor + note when top-1's type is not in the primary-attribute map — but still surfaces candidates when types match", async () => {
      // Grooming isn't in the SUBSTITUTE_PRIMARY_ATTRIBUTE map. The
      // tool still returns same-type candidates; the primary
      // attribute is null (nothing to compare on). Not a fall-
      // through to empty — an honest observability signal that
      // attribute-level filtering is out of scope for this type.
      const tool = new ProductSubstituteLookupTool(
        makeRetriever([
          makeChunk({
            chunkId: 'anchor',
            score: 0.6,
            metadata: {
              type: 'Grooming',
              handle: 'a-grooming-product',
              vendor: 'V',
              extracted_attributes: [],
            },
          }),
          makeChunk({
            chunkId: 'cand',
            score: 0.55,
            metadata: {
              type: 'Grooming',
              handle: 'another-grooming-product',
              vendor: 'V',
              extracted_attributes: [],
            },
          }),
        ]),
      );
      const result = await tool.invoke({
        name: 'product.substitute_lookup',
        args: { productQuery: 'grooming thing', stockStatus: 'orderable' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as SubstituteLookupResult;
      expect(value.anchor?.type).toBe('Grooming');
      expect(value.anchor?.primaryAttribute).toBeNull();
      expect(value.substitutes.map((s) => s.handle)).toEqual([
        'a-grooming-product',
        'another-grooming-product',
      ]);
    });

    it('returns null anchor + note when retriever returned nothing', async () => {
      const tool = new ProductSubstituteLookupTool(makeRetriever([]));
      const result = await tool.invoke({
        name: 'product.substitute_lookup',
        args: { productQuery: 'nothing here', stockStatus: 'orderable' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as SubstituteLookupResult;
      expect(value.substitutes).toEqual([]);
      expect(value.anchor).toBeNull();
      expect(value.note).toContain('no candidates');
    });

    it('returns null anchor + note when top-1 metadata is missing type or handle', async () => {
      const tool = new ProductSubstituteLookupTool(
        makeRetriever([makeChunk({ chunkId: 'anchor', score: 0.6, metadata: {} })]),
      );
      const result = await tool.invoke({
        name: 'product.substitute_lookup',
        args: { productQuery: 'anything', stockStatus: 'orderable' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as SubstituteLookupResult;
      expect(value.substitutes).toEqual([]);
      expect(value.anchor).toBeNull();
      expect(value.note).toContain('type or handle');
    });
  });

  describe('argument validation', () => {
    it('rejects empty productQuery', async () => {
      const tool = new ProductSubstituteLookupTool(makeRetriever([]));
      const result = await tool.invoke({
        name: 'product.substitute_lookup',
        args: { productQuery: '', stockStatus: 'orderable' },
      });
      expect(result.ok).toBe(false);
    });

    it('rejects invalid stockStatus', async () => {
      const tool = new ProductSubstituteLookupTool(makeRetriever([]));
      const result = await tool.invoke({
        name: 'product.substitute_lookup',
        args: { productQuery: 'test', stockStatus: 'nonsense' },
      });
      expect(result.ok).toBe(false);
    });

    it('rejects calls with the wrong tool name', async () => {
      const tool = new ProductSubstituteLookupTool(makeRetriever([]));
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'test', stockStatus: 'orderable' },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('tool not found');
    });
  });
});
