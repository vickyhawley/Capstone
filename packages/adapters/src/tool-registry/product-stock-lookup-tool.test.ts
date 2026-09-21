/**
 * Unit tests for ProductStockLookupTool. GW-20 / ADR-0016.
 *
 * Uses stub retriever inline — no Supabase, no real corpus. Tests
 * every branch of the four-state decision logic (§2), the ordering
 * (unavailable > pending > orderable), the minMatchScore floor (§3),
 * and the structured-error paths for arg validation (§5).
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
  extractContentTokens,
  matchesQueryTokens,
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

interface StatusOverride {
  readonly name: string;
  readonly matcher: 'substring';
  readonly pattern: string;
  readonly reason: string;
}

/**
 * Test helper — construct the tool with the same retriever passed as
 * both the hybrid and the dense retriever. Fine for the decision-logic
 * tests: the tool's threshold is applied to the dense retriever's
 * top-1 cosine score (ADR-0016 §3), and a stub that returns a chunk
 * with `score: 0.72` serves that role directly. The dedicated
 * "dense retriever gates the floor" test at the bottom of the file
 * uses `makeTool(...)` explicitly with divergent
 * hybrid + dense retrievers to prove the gating source.
 */
function makeTool(
  retriever: Retriever,
  outOfScope: readonly StatusOverride[],
  pending?: readonly StatusOverride[],
): ProductStockLookupTool {
  return new ProductStockLookupTool(retriever, retriever, outOfScope, pending);
}

// Test fixtures invented for tests, not copied from the SME-curated
// yaml files or the golden set — eval-hygiene rule (same as router's
// rules.test.ts and llm-classifier.ts).
const OUT_OF_SCOPE = [
  {
    name: 'TestBrandA',
    matcher: 'substring' as const,
    pattern: 'TestBrandA',
    reason: 'not stocked commercially; alternative local stockist carries the range',
  },
  {
    name: 'TestBrandB',
    matcher: 'substring' as const,
    pattern: 'TestBrandB',
    reason: 'not stocked commercially',
  },
];

const PENDING = [
  {
    name: 'test-pending-category',
    matcher: 'substring' as const,
    pattern: 'test-pending',
    reason: 'pending regulatory pre-condition; committed to stock once resolved',
  },
];

describe('ProductStockLookupTool', () => {
  describe('list()', () => {
    it('advertises exactly one tool, named product.stock_lookup', () => {
      const tool = makeTool(makeRetriever([]), OUT_OF_SCOPE);
      const defs = tool.list();
      expect(defs).toHaveLength(1);
      expect(defs[0]?.name).toBe('product.stock_lookup');
    });

    it('exposes an args schema with productQuery required', () => {
      const tool = makeTool(makeRetriever([]), OUT_OF_SCOPE);
      const schema = tool.list()[0]?.schema as { required?: string[] };
      expect(schema.required).toContain('productQuery');
    });
  });

  describe('invoke() — four-state decision (ADR-0016 §2)', () => {
    it('returns EXACT when retriever returns a chunk at/above the threshold', async () => {
      const tool = makeTool(
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
      const tool = makeTool(makeRetriever([]), OUT_OF_SCOPE);
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
      const tool = makeTool(makeRetriever([]), OUT_OF_SCOPE, PENDING);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'do you sell TESTBRANDA jackets' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('unavailable');
      expect(value.outOfScopeReason).toBe(
        'not stocked commercially; alternative local stockist carries the range',
      );
      expect(value.pendingReason).toBeNull();
    });

    it('returns PENDING when pending pattern matches (SME correction 2026-09-17)', async () => {
      const tool = makeTool(makeRetriever([]), OUT_OF_SCOPE, PENDING);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'do you sell test-pending items' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('pending');
      expect(value.pendingReason).toBe(
        'pending regulatory pre-condition; committed to stock once resolved',
      );
      expect(value.outOfScopeReason).toBeNull();
    });

    it('EXACT beats UNAVAILABLE — the corpus wins over the out-of-scope list', async () => {
      // ADR-0016 §2: if a product is BOTH in the corpus AND on the out-
      // of-scope list, corpus wins. A shipped product isn't
      // hypothetical; a policy about what NFCS won't source is defeated
      // by evidence that NFCS did source it.
      const tool = makeTool(
        makeRetriever([
          makeChunk({
            score: 0.8,
            chunkId: 'exact-brand-a-chunk',
            metadata: { handle: 'test-brand-a-item', title: 'Some Actual TestBrandA Item' },
          }),
        ]),
        OUT_OF_SCOPE,
        PENDING,
      );
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        // Handle-match check (ADR-0016 §3.5): "TestBrandA item"
        // singular so tokens ground against the fixture chunk's
        // title. This test is about override ordering, not the
        // stemming question — the stemming/plural limitation is
        // named in the ADR and covered by its own tests below.
        args: { productQuery: 'TestBrandA item' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value as StockLookupResult).status).toBe('exact');
    });

    it('UNAVAILABLE beats PENDING — a permanent brand block overrides a category pending', async () => {
      // ADR-0016 §2: if a query matches BOTH the out-of-scope list
      // AND the pending list (e.g. a LeMieux fencing product when
      // fencing is pending F1), the brand blocker wins. Brand is
      // permanent; the pending category is temporary.
      const tool = makeTool(makeRetriever([]), OUT_OF_SCOPE, PENDING);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'TestBrandA test-pending combo item' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('unavailable');
      expect(value.pendingReason).toBeNull();
    });

    it('PENDING beats ORDERABLE — a committed pre-condition is a better answer than "we can source that"', async () => {
      // Absent explicit config, orderable is the fall-through default.
      // A pending entry should be preferred so the customer answer
      // names the specific pre-condition rather than the generic
      // sourcing offer.
      const tool = makeTool(makeRetriever([]), OUT_OF_SCOPE, PENDING);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'do you have test-pending stock yet' },
      });
      expect(result.ok).toBe(true);
      expect((result as { value: StockLookupResult }).value.status).toBe('pending');
    });

    it('constructor default: no pending list argument → no pending matches, falls to orderable', async () => {
      // Backwards-compatible default — old three-state callers work
      // without needing to pass the pending list.
      const tool = makeTool(makeRetriever([]), OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'test-pending item' },
      });
      expect(result.ok).toBe(true);
      expect((result as { value: StockLookupResult }).value.status).toBe('orderable');
    });
  });

  describe('minMatchScore floor (ADR-0016 §3)', () => {
    it('BELOW the default floor of 0.5 falls through to orderable', async () => {
      const tool = makeTool(makeRetriever([makeChunk({ score: 0.3 })]), OUT_OF_SCOPE);
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
      const tool = makeTool(
        makeRetriever([makeChunk({ score: DEFAULT_MIN_MATCH_SCORE })]),
        OUT_OF_SCOPE,
      );
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        // Query tokens must ground against the default fixture
        // metadata (`handle: 'test-handle', title: 'Test Product'`)
        // per the handle-match check (ADR-0016 §3.5). This test is
        // about `>= floor`, not about the grounding check.
        args: { productQuery: 'test product' },
      });
      expect(result.ok).toBe(true);
      expect((result as { value: StockLookupResult }).value.status).toBe('exact');
    });

    it('explicit null minMatchScore accepts any match (characterisation mode)', async () => {
      // ADR-0016 §3: null is smoke-only, never reaches customers. This
      // test proves the code path exists for the smoke script; the
      // registration-side wiring enforces "never null in prod" (task #6).
      const tool = makeTool(makeRetriever([makeChunk({ score: 0.01 })]), OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        // Grounded query per §3.5 — this test is about the null-
        // floor code path.
        args: { productQuery: 'test product', minMatchScore: null },
      });
      expect(result.ok).toBe(true);
      expect((result as { value: StockLookupResult }).value.status).toBe('exact');
    });

    it('explicit numeric override replaces the default', async () => {
      const tool = makeTool(makeRetriever([makeChunk({ score: 0.6 })]), OUT_OF_SCOPE);
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
      const tool = makeTool(makeRetriever([]), OUT_OF_SCOPE);
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
      const tool = makeTool(makeRetriever([]), OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: '   ' },
      });
      expect(result.ok).toBe(false);
    });

    it('returns ok:false on missing productQuery', async () => {
      const tool = makeTool(makeRetriever([]), OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: {},
      });
      expect(result.ok).toBe(false);
    });

    it('returns ok:false on oversized productQuery (>200 chars)', async () => {
      const tool = makeTool(makeRetriever([]), OUT_OF_SCOPE);
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
      const tool = makeTool(makeRetriever([]), OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'some.other.tool',
        args: { productQuery: 'test' },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('tool not found');
    });

    it('returns ok:false on malformed minMatchScore (non-numeric)', async () => {
      const tool = makeTool(makeRetriever([]), OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'test', minMatchScore: 'not-a-number' },
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('metadata resilience', () => {
    it('handles missing handle/title in chunk metadata — returns null', async () => {
      const tool = makeTool(
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
        // Handle-match check (ADR-0016 §3.5) falls back to `chunk.text`
        // when handle/title are absent. The default fixture text is
        // "some product content" — tokens ground against that.
        args: { productQuery: 'some product content' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('exact');
      expect(value.matchedHandle).toBeNull();
      expect(value.matchedTitle).toBeNull();
    });
  });

  describe('dense retriever gates the confidence floor (ADR-0016 §3)', () => {
    // RRF scores are ordinal — a rank-0 hit on a tangential chunk
    // scores identically to a rank-0 hit on the correct product.
    // The floor applies to the dense retriever's cosine score, which
    // is metric and carries confidence. These tests construct the
    // tool with divergent hybrid + dense retrievers to prove the
    // gating source explicitly.

    it('EXACT when dense top-1 is above floor even if hybrid top-1 is low', async () => {
      // Hybrid returns a chunk with RRF score 0.033 (typical rank-0
      // in both children), dense returns the same chunk with cosine
      // 0.72. Under the old design (floor on hybrid), 0.033 fails
      // 0.5 → orderable. Under Option A (floor on dense), 0.72
      // passes 0.5 → exact. Same chunk IDs and metadata surface.
      const hybrid = makeRetriever([
        makeChunk({
          score: 0.033,
          chunkId: 'hybrid-chunk',
          metadata: { handle: 'burley-bale', title: 'Burley Bale Haylage' },
        }),
      ]);
      const dense = makeRetriever([
        makeChunk({
          score: 0.72,
          chunkId: 'hybrid-chunk',
          metadata: { handle: 'burley-bale', title: 'Burley Bale Haylage' },
        }),
      ]);
      const tool = new ProductStockLookupTool(hybrid, dense, OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'burley bale haylage' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('exact');
      // matchedChunkIds come from hybrid (ordering + citations).
      expect(value.matchedChunkIds).toEqual(['hybrid-chunk']);
      // matchScore is the cosine score, not the RRF score — that's
      // what observability needs to see.
      expect(value.matchScore).toBe(0.72);
    });

    it('ORDERABLE when dense top-1 is below floor even if hybrid returns chunks', async () => {
      // Hybrid returns a chunk (tangential brand mention scoring
      // rank-0 via RRF), dense returns cosine 0.3 — below the 0.5
      // floor. Correct answer: don't claim exact, fall through to
      // orderable. This is the failure mode Option A defends against
      // that the previous design allowed through.
      const hybrid = makeRetriever([
        makeChunk({
          score: 0.033,
          chunkId: 'tangential-chunk',
          metadata: { handle: 'tangential', title: 'Tangential' },
        }),
      ]);
      const dense = makeRetriever([makeChunk({ score: 0.3, chunkId: 'tangential-chunk' })]);
      const tool = new ProductStockLookupTool(hybrid, dense, OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'nothing shop stocks' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('orderable');
      // matchScore surfaced for observability even on non-exact:
      // it's the cosine confidence, which is what the threshold
      // discipline in ADR-0016 §3 requires.
      expect(value.matchScore).toBe(0.3);
    });

    it('ORDERABLE when dense returns nothing (retrieval empty)', async () => {
      // Dense returns []. No cosine signal at all → cannot claim
      // exact. Falls through to the override checks (out-of-scope /
      // pending) and, absent a match, orderable.
      const hybrid = makeRetriever([makeChunk({ score: 0.033 })]);
      const dense = makeRetriever([]);
      const tool = new ProductStockLookupTool(hybrid, dense, OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'anything' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('orderable');
      expect(value.matchScore).toBeNull();
    });
  });

  describe('handle-match check (ADR-0016 §3.5) — extractContentTokens', () => {
    it('lowercases + splits on whitespace + drops stopwords + enforces length ≥ 3', () => {
      expect(extractContentTokens('do you sell Molichaff Hoofkind')).toEqual([
        'molichaff',
        'hoofkind',
      ]);
    });

    it('splits on hyphens and underscores as well as whitespace', () => {
      // Shopify-style handles and multi-word product names split
      // the same way. `Western-Timothy_Haylage` → three tokens.
      expect(extractContentTokens('Western-Timothy_Haylage')).toEqual([
        'western',
        'timothy',
        'haylage',
      ]);
    });

    it('drops punctuation and social filler', () => {
      expect(extractContentTokens('Hi! Please, do you carry Ariat?')).toEqual(['ariat']);
    });

    it('drops sub-3-char tokens even if not in the stopword list', () => {
      // "ok" and "hi" are stopwords; "a" and "b" are sub-3-char.
      expect(extractContentTokens('do a b 4x hats')).toEqual(['hats']);
    });

    it('returns an empty list when the query is only stopwords + filler', () => {
      expect(extractContentTokens('hi please do you have')).toEqual([]);
    });
  });

  describe('handle-match check (ADR-0016 §3.5) — matchesQueryTokens', () => {
    it('returns true when every content token appears in handle + title + text', () => {
      const chunk = {
        text: 'Molichaff Hoofkind supports laminitic feed regimes',
        metadata: { handle: 'molichaff-hoofkind', title: 'Molichaff Hoofkind' },
      };
      expect(matchesQueryTokens('Molichaff Hoofkind', chunk)).toBe(true);
    });

    it('returns false when any content token is missing from the haystack', () => {
      // Case 044 shape — "Western Timothy Haylage" vs a HorseHage
      // Timothy chunk. `western` is not present anywhere. Rule
      // fails, tool falls through to orderable.
      const chunk = {
        text: 'HorseHage Timothy grass is higher in fibre and lower in protein…',
        metadata: { handle: 'horsehage-timothy', title: 'HorseHage Timothy Haylage' },
      };
      expect(matchesQueryTokens('Western Timothy Haylage', chunk)).toBe(false);
    });

    it('is case-insensitive', () => {
      const chunk = {
        text: 'some product body',
        metadata: { handle: 'MOLICHAFF-HOOFKIND', title: 'Molichaff Hoofkind' },
      };
      expect(matchesQueryTokens('molichaff HOOFKIND', chunk)).toBe(true);
    });

    it('scans chunk.text when handle/title are absent', () => {
      const chunk = { text: 'ariat mentioned in body', metadata: {} };
      expect(matchesQueryTokens('Ariat', chunk)).toBe(true);
    });

    it('order does not matter — the check is on presence, not sequence', () => {
      const chunk = {
        text: '',
        metadata: { handle: 'molichaff-hoofkind', title: 'Molichaff Hoofkind' },
      };
      // Reversed order — "Hoofkind Molichaff" still grounds.
      expect(matchesQueryTokens('Hoofkind Molichaff', chunk)).toBe(true);
    });

    it('empty-content queries return true (pathological edge case)', () => {
      // "Hi please do you have" has zero content tokens after
      // stopword + length filtering. Rule passes because there is
      // nothing to check — the tool falls back to floor + retrieval
      // alone. Documented in ADR-0016 §3.5.
      const chunk = { text: 'anything', metadata: {} };
      expect(matchesQueryTokens('hi please do you have', chunk)).toBe(true);
    });

    it('typos are the genuine limitation — mid-word substitution fails', () => {
      // Documented in ADR-0016 §3.5: typos regress to `orderable`
      // (safer failure direction). Fuzzy/edit-distance match is
      // the eventual answer. Note the substring check catches
      // some typos accidentally (a truncation like "molichaf" is
      // a substring of "molichaff") and misses others (mid-word
      // substitution like "moliehaff" isn't). The check is
      // presence, not fuzzy match.
      const chunk = { text: '', metadata: { handle: 'molichaff-hoofkind', title: '' } };
      expect(matchesQueryTokens('moliehaff hoofkind', chunk)).toBe(false);
    });

    it('trade-synonym queries regress — "purple horsehage" vs HorseHage Timothy chunk', () => {
      // Case 007 shape — customer uses HorseHage's colour code
      // ("Purple" = Timothy) but the corpus chunk uses the canonical
      // species name. `purple` is not present in the chunk anywhere.
      // Rule fails, case regresses from currently-exact to orderable.
      // ADR-0009 (synonym dictionary) is where this class is fixed.
      const chunk = {
        text: 'HorseHage Timothy grass is higher in fibre and lower in protein…',
        metadata: { handle: 'horsehage-timothy', title: '' },
      };
      expect(matchesQueryTokens('purple horsehage', chunk)).toBe(false);
    });
  });

  describe('handle-match check (ADR-0016 §3.5) — integration with the exact branch', () => {
    it('cosine passes floor + tokens grounded → exact', async () => {
      const hybrid = makeRetriever([
        makeChunk({
          score: 0.033,
          chunkId: 'molichaff-chunk',
          metadata: { handle: 'molichaff-hoofkind', title: 'Molichaff Hoofkind' },
        }),
      ]);
      const dense = makeRetriever([
        makeChunk({
          score: 0.72,
          chunkId: 'molichaff-chunk',
          metadata: { handle: 'molichaff-hoofkind', title: 'Molichaff Hoofkind' },
        }),
      ]);
      const tool = new ProductStockLookupTool(hybrid, dense, OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'Molichaff Hoofkind' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('exact');
    });

    it('cosine passes floor + tokens ungrounded → orderable (case-044 defence)', async () => {
      // Query names a brand ("Western") that isn't in the chunk. Cosine
      // sees them as similar (both Timothy haylages) but the tool
      // refuses to claim exact. This is the false-`exact` failure
      // Option A alone couldn't catch.
      const hybrid = makeRetriever([
        makeChunk({
          score: 0.033,
          chunkId: 'horsehage-timothy-chunk',
          metadata: { handle: 'horsehage-timothy', title: 'HorseHage Timothy Haylage' },
          text: 'HorseHage Timothy is a grass haylage with high fibre…',
        }),
      ]);
      const dense = makeRetriever([
        makeChunk({
          score: 0.644,
          chunkId: 'horsehage-timothy-chunk',
          metadata: { handle: 'horsehage-timothy', title: 'HorseHage Timothy Haylage' },
          text: 'HorseHage Timothy is a grass haylage with high fibre…',
        }),
      ]);
      const tool = new ProductStockLookupTool(hybrid, dense, OUT_OF_SCOPE);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'Western Timothy Haylage' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('orderable');
    });
  });

  describe('subscriptionEligible (Sprint 4)', () => {
    // Matches how the SME configured shop-info: Feed, Bedding,
    // Haylage. Case-sensitive against chunk metadata.type.
    const ELIGIBLE_TYPES = ['Feed', 'Bedding', 'Haylage'];

    function makeToolWithSubscription(
      retriever: Retriever,
      types: readonly string[] = ELIGIBLE_TYPES,
    ): ProductStockLookupTool {
      return new ProductStockLookupTool(retriever, retriever, OUT_OF_SCOPE, [], types);
    }

    it('exact match on Feed type → subscriptionEligible=true', async () => {
      const retriever = makeRetriever([
        makeChunk({
          score: 0.72,
          metadata: {
            handle: 'coarse-mix',
            title: 'Coarse Mix',
            type: 'Feed',
          },
        }),
      ]);
      const tool = makeToolWithSubscription(retriever);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'Coarse Mix' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('exact');
      expect(value.subscriptionEligible).toBe(true);
    });

    it('exact match on Outerwear (non-eligible) → subscriptionEligible=false', async () => {
      const retriever = makeRetriever([
        makeChunk({
          score: 0.72,
          metadata: {
            handle: 'wax-jacket',
            title: 'Wax Jacket',
            type: 'Outerwear',
          },
        }),
      ]);
      const tool = makeToolWithSubscription(retriever);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'Wax Jacket' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('exact');
      expect(value.subscriptionEligible).toBe(false);
    });

    it('unavailable (out-of-scope) → subscriptionEligible=null (no product matched)', async () => {
      const retriever = makeRetriever([]);
      const tool = makeToolWithSubscription(retriever);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'TestBrandA saddle' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('unavailable');
      expect(value.subscriptionEligible).toBeNull();
    });

    it('orderable with retrieval hit on Bedding → subscriptionEligible=true', async () => {
      // Non-exact orderable (cosine passes but tokens ungrounded)
      // can still be subscription-eligible if the matched chunk's
      // type is in the list. Customer is asking about a bedding
      // product NFCS can source but doesn't hold — recurring
      // delivery still makes sense.
      const retriever = makeRetriever([
        makeChunk({
          score: 0.033,
          metadata: {
            handle: 'aubiose-hemp',
            title: 'Aubiose Hemp Bedding',
            type: 'Bedding',
          },
          text: 'Aubiose is a hemp bedding option.',
        }),
      ]);
      const denseRetriever = makeRetriever([
        makeChunk({
          score: 0.55, // below the token-grounding path's threshold
          metadata: {
            handle: 'aubiose-hemp',
            title: 'Aubiose Hemp Bedding',
            type: 'Bedding',
          },
        }),
      ]);
      const tool = new ProductStockLookupTool(
        retriever,
        denseRetriever,
        OUT_OF_SCOPE,
        [],
        ELIGIBLE_TYPES,
      );
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'unknown-brand hemp bedding' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value as StockLookupResult;
      expect(value.status).toBe('orderable');
      expect(value.subscriptionEligible).toBe(true);
    });

    it('empty eligibleTypes list → always false when matched, null otherwise', async () => {
      const retriever = makeRetriever([
        makeChunk({
          score: 0.72,
          metadata: {
            handle: 'coarse-mix',
            title: 'Coarse Mix',
            type: 'Feed',
          },
        }),
      ]);
      const tool = new ProductStockLookupTool(retriever, retriever, OUT_OF_SCOPE, [], []);
      const result = await tool.invoke({
        name: 'product.stock_lookup',
        args: { productQuery: 'Coarse Mix' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value as StockLookupResult).subscriptionEligible).toBe(false);
    });
  });
});
