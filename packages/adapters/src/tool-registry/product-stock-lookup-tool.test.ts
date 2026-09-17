/**
 * Unit tests for ProductStockLookupTool. GW-20 / ADR-0016.
 *
 * Uses stub retriever inline — no Supabase, no real corpus. Tests
 * every branch of the three-state decision logic (§2), the
 * minMatchScore floor (§3), the exact-beats-unavailable ordering
 * rule (§2), and the structured-error paths for arg validation (§5).
 *
 * The mandatory Supabase smoke (task #8) covers the "does this work
 * against a real corpus" question. This file covers "is the decision
 * logic correct given a known retrieval result".
 */

import type { RetrievalQuery, RetrievedChunk, Retriever } from '@groundwork/core';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIN_MATCH_SCORE,
  ProductStockLookupTool,
  type StockLookupResult,
} from './product-stock-lookup-tool.js';

function makeRetriever(results: readonly RetrievedChunk[]): Retriever {
  return {
    async retrieve(_query: RetrievalQuery): Promise<readonly RetrievedChunk[]> {
      return results;
    },
  };
}

function makeChunk(overrides: Partial<RetrievedChunk> & { score: number }): RetrievedChunk {
  return {
    chunkId: overrides.chunkId ?? '00000000-0000-0000-0000-000000000001',
    documentId: overrides.documentId ?? '00000000-0000-0000-0000-000000000002',
    text: overrides.text ?? 'some product content',
    score: overrides.score,
    metadata: overrides.metadata ?? { handle: 'test-handle', title: 'Test Product' },
  };
}

const OUT_OF_SCOPE = [
  {
    name: 'wormers',
    matcher: 'substring' as const,
    pattern: 'wormer',
    reason: 'vet-script product, NFCS does not sell',
  },
  {
    name: 'electric fencing',
    matcher: 'substring' as const,
    pattern: 'electric fencing',
    reason: 'out of NFCS product category',
  },
];

describe('ProductStockLookupTool', () => {
  describe('list()', () => {
    it('advertises exactly one tool, named product.stock_lookup', () => {
      const tool = new ProductStockLookupTool(makeRetriever([]), OUT_OF_SCOPE);
      const defs = tool.list();
      expect(defs).toHaveLength(1);
      expect(defs[0]?.name).toBe('product.stock_lookup');
    });

    it('exposes an args schema with productQuery required', () => {
      const tool = new ProductStockLookupTool(makeRetriever([]), OUT_OF_SCOPE);
      const schema = tool.list()[0]?.schema as { required?: string[] };
      expect(schema.required).toContain('productQuery');
    });
  });

  describe('invoke() — three-state decision (ADR-0016 §2)', () => {
    it('returns EXACT when retriever returns a chunk at/above the threshold', async () => {
      const tool = new ProductStockLookupTool(
        makeRetriever([
          makeChunk({
            score: 0.72,
            chunkId: 'exact-1',
            metadata: { handle: 'burley-bale', title: 'Burley Bale Haylage' },
          }),
        ]),
        OUT_OF_SCOPE,
      );
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'burley bale haylage' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('exact');
      expect(value.matchedChunkIds).toEqual(['exact-1']);
      expect(value.matchedHandle).toBe('burley-bale');
      expect(value.matchedTitle).toBe('Burley Bale Haylage');
      expect(value.outOfScopeReason).toBeNull();
      expect(value.matchScore).toBe(0.72);
    });

    it('returns ORDERABLE when retriever finds nothing and out-of-scope has no match', async () => {
      const tool = new ProductStockLookupTool(makeRetriever([]), OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'saracens veteran balancer' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('orderable');
      expect(value.matchedChunkIds).toEqual([]);
      expect(value.matchedHandle).toBeNull();
      expect(value.matchedTitle).toBeNull();
      expect(value.outOfScopeReason).toBeNull();
      expect(value.matchScore).toBeNull();
    });

    it('returns UNAVAILABLE when out-of-scope pattern matches (case-insensitive substring)', async () => {
      const tool = new ProductStockLookupTool(makeRetriever([]), OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'do you sell WORMERS' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('unavailable');
      expect(value.outOfScopeReason).toBe('vet-script product, NFCS does not sell');
    });

    it('returns UNAVAILABLE on the "electric fencing" pattern (multi-word substring)', async () => {
      const tool = new ProductStockLookupTool(makeRetriever([]), OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'do you stock electric fencing kits' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value as StockLookupResult).status).toBe('unavailable');
    });

    it('EXACT beats UNAVAILABLE — the corpus wins over the out-of-scope list', async () => {
      // ADR-0016 §2: if a product is BOTH in the corpus AND on the out-
      // of-scope list, corpus wins. A shipped product isn't
      // hypothetical; a policy about what NFCS won't source is defeated
      // by evidence that NFCS did source it.
      const tool = new ProductStockLookupTool(
        makeRetriever([
          makeChunk({
            score: 0.8,
            chunkId: 'exact-wormer-chunk',
            metadata: { handle: 'test-wormer', title: 'Some Actual Wormer' },
          }),
        ]),
        OUT_OF_SCOPE,
      );
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'do you sell wormers' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value as StockLookupResult).status).toBe('exact');
    });
  });

  describe('minMatchScore floor (ADR-0016 §3)', () => {
    it('BELOW the default floor of 0.5 falls through to orderable', async () => {
      const tool = new ProductStockLookupTool(
        makeRetriever([makeChunk({ score: 0.3 })]),
        OUT_OF_SCOPE,
      );
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'noisy adjacent match' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('orderable');
      // matchScore is still captured — smoke uses this to characterise
      // the distribution (§3 baseline sizing).
      expect(value.matchScore).toBe(0.3);
    });

    it('AT the default floor of 0.5 counts as exact (>= comparison)', async () => {
      const tool = new ProductStockLookupTool(
        makeRetriever([makeChunk({ score: DEFAULT_MIN_MATCH_SCORE })]),
        OUT_OF_SCOPE,
      );
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'boundary match' },
      });
      expect(result.ok).toBe(true);
      expect((result as { value: StockLookupResult }).value.status).toBe('exact');
    });

    it('explicit null minMatchScore accepts any match (characterisation mode)', async () => {
      // ADR-0016 §3: null is smoke-only, never reaches customers. This
      // test proves the code path exists for the smoke script; the
      // registration-side wiring enforces "never null in prod" (task #6).
      const tool = new ProductStockLookupTool(
        makeRetriever([makeChunk({ score: 0.01 })]),
        OUT_OF_SCOPE,
      );
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'anything', minMatchScore: null },
      });
      expect(result.ok).toBe(true);
      expect((result as { value: StockLookupResult }).value.status).toBe('exact');
    });

    it('explicit numeric override replaces the default', async () => {
      const tool = new ProductStockLookupTool(
        makeRetriever([makeChunk({ score: 0.6 })]),
        OUT_OF_SCOPE,
      );
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'test', minMatchScore: 0.8 },
      });
      expect(result.ok).toBe(true);
      // 0.6 < 0.8 → below floor → orderable, not exact.
      expect((result as { value: StockLookupResult }).value.status).toBe('orderable');
    });
  });

  describe('structured errors (ADR-0016 §5)', () => {
    it('returns ok:false, retryable:false on empty productQuery', async () => {
      const tool = new ProductStockLookupTool(makeRetriever([]), OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: '' },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('non-empty');
    });

    it('returns ok:false on whitespace-only productQuery', async () => {
      const tool = new ProductStockLookupTool(makeRetriever([]), OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: '   ' },
      });
      expect(result.ok).toBe(false);
    });

    it('returns ok:false on missing productQuery', async () => {
      const tool = new ProductStockLookupTool(makeRetriever([]), OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: {},
      });
      expect(result.ok).toBe(false);
    });

    it('returns ok:false on oversized productQuery (>200 chars)', async () => {
      const tool = new ProductStockLookupTool(makeRetriever([]), OUT_OF_SCOPE);
      const oversized = 'x'.repeat(201);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: oversized },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('max length');
    });

    it('returns ok:false on unknown tool name', async () => {
      const tool = new ProductStockLookupTool(makeRetriever([]), OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'some.other.tool',
        args: { productQuery: 'test' },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('tool not found');
    });

    it('returns ok:false on malformed minMatchScore (non-numeric)', async () => {
      const tool = new ProductStockLookupTool(makeRetriever([]), OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'test', minMatchScore: 'not-a-number' },
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('metadata resilience', () => {
    it('handles missing handle/title in chunk metadata — returns null', async () => {
      const tool = new ProductStockLookupTool(
        makeRetriever([
          makeChunk({
            score: 0.8,
            chunkId: 'no-meta',
            metadata: {}, // empty
          }),
        ]),
        OUT_OF_SCOPE,
      );
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'test' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('exact');
      expect(value.matchedHandle).toBeNull();
      expect(value.matchedTitle).toBeNull();
    });
  });
});
