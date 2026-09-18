/**
 * ProductSubstituteLookupTool. GW-19 / ADR-0005 (design closed
 * 2026-09-18 per user answers to the design proposal in sprint-log).
 *
 * Runs after `product.stock_lookup` returns non-exact. Takes the same
 * productQuery plus the originating stock status. Returns ranked
 * substitute candidates so synthesis can compose the two-thing
 * customer answer: "we don't stock X (from stock_lookup), but we
 * have Y (from this tool)".
 *
 * Design (see ADR-0005 addendum 2026-09-18 — revised at smoke time,
 * see sprint-log GW-19 close-out for the revision):
 *
 *   - Re-invoke retrieval with the productQuery. Separate embed per
 *     call — worth one OpenAI embed for tool-separability. A per-
 *     request embedding cache is a Sprint-4 optimisation, not a
 *     blocker.
 *
 *   - Anchor on the top-1 dense-retrieval candidate's metadata (Path
 *     B). When stock_lookup returned non-exact, the top-1 IS the
 *     closest product NFCS stocks — that IS the substitute the shop
 *     would recommend. Not "anchor to find OTHER substitutes for" —
 *     the top-1 is the answer.
 *
 *   - Substitute rule:
 *       1. Chunk has `type` metadata (drops guide chunks that
 *          slipped past the retriever's content_type filter).
 *       2. Chunk's `type` matches the anchor's type.
 *       3. Chunk is in-corpus (implicit — retrieval returned it).
 *     Note the anchor itself is INCLUDED as a valid substitute
 *     candidate. The "closest product we stock" is the primary
 *     answer.
 *
 *   - The type-specific primary attribute (Feed → form; Haylage →
 *     cut_type; Bedding → material; Supplements → target_concern;
 *     Outerwear → fit) is READ FROM the anchor and surfaced on the
 *     result for observability. It is NOT used as a filter — the
 *     smoke on case 022 (2026-09-18) showed the anchor's own
 *     extracted attribute (`form: mix` on `hilight-conditioning-
 *     cubes`) was wrong per ADR-0004 extraction quality, and using
 *     it as a filter removed valid substitutes. Attribute quality
 *     is on the roadmap; the tool trusts retrieval's top-K for
 *     candidate selection.
 *
 *   - Ordering: same-vendor-as-anchor beats cross-vendor, then
 *     higher cosine, then chunk-id lex. Cap at 3.
 *
 *   - If invoked with stockStatus === 'exact', returns
 *     `substitutes: []` and `note: 'stock is exact'`. Substitute
 *     reasoning would confuse the customer answer when the exact
 *     item is available.
 *
 * Named limitations (recorded in ADR-0005 addendum):
 *   - No complement graph (all different-type candidates → dropped
 *     as `unrelated`). Sprint-4 sub-story per ADR-0005.
 *   - No learned relationships (McAuley co-view). Needs real
 *     traffic; Sprint 4+.
 *   - No price-tier ranking axis. Prices surfaced per-candidate; the
 *     first pass doesn't sort on price gap.
 *   - No attribute-based filter on candidates. If ADR-0004
 *     extraction improves, revisit — the primary-attribute filter
 *     is a legitimate future refinement.
 *   - Path A query-side extraction not implemented. Roadmap.
 *   - Wrong-species retrieval passes through (e.g. Ryegrass query
 *     returning Timothy top-1 as substitute). Retriever quality
 *     issue, not a tool-design one.
 */

import type {
  Retriever,
  ToolDefinition,
  ToolInvocation,
  ToolRegistry,
  ToolResult,
} from '@groundwork/core';

const TOOL_NAME = 'product.substitute_lookup';

/** Max productQuery length (mirrors ProductStockLookupTool). */
const MAX_PRODUCT_QUERY_LENGTH = 200;

/** Retrieval top-K for the substitute search. Larger than
 *  stock_lookup's (which serves the exact answer) because substitute
 *  candidates may sit below the exact-match's dense score. */
const RETRIEVAL_TOP_K = 10;

/** Cap on returned substitutes. More than 3 in a customer answer is
 *  noise; the shop's real answers name 1–2. */
const MAX_SUBSTITUTES = 3;

/**
 * Primary attribute per product type — the axis the customer is
 * choosing on. Two candidates substitute for each other iff their
 * primary attribute values match. Extensible; types not in the map
 * fall through to `substitutes: []` with a note.
 *
 * Rationale for the choices (recorded in ADR-0005 addendum 2026-09-18):
 * - Feed → `form`: a mix isn't a substitute for a balancer even if
 *   both are Feed. Form is the coarsest customer-facing dimension.
 * - Haylage → `cut_type`: species (timothy / ryegrass) determines
 *   suitability for laminitic horses etc. The case-044 driver.
 * - Bedding → `material`: shavings vs hemp vs straw is the choice
 *   the customer is making. Bag-size is a secondary consideration.
 * - Supplements → `target_concern`: joint / calming / gut / hoof —
 *   what the supplement addresses.
 * - Outerwear → `fit`: turnout / stable / travel — which context
 *   the rug/coat is for.
 */
export const SUBSTITUTE_PRIMARY_ATTRIBUTE: Readonly<Record<string, string>> = Object.freeze({
  Feed: 'form',
  Haylage: 'cut_type',
  Bedding: 'material',
  Supplements: 'target_concern',
  Outerwear: 'fit',
});

interface ExtractedAttributeValue {
  readonly key: string;
  readonly value: string | number | boolean | null;
  readonly confidence?: number;
}

export interface SubstituteAttributeAgreement {
  readonly key: string;
  readonly queryValue: string | number | boolean | null;
  readonly candidateValue: string | number | boolean | null;
  readonly matches: boolean;
  readonly primary: boolean;
}

export interface SubstituteCandidate {
  readonly chunkId: string;
  readonly handle: string;
  readonly title: string | null;
  readonly vendor: string | null;
  readonly priceMin: number | null;
  readonly priceMax: number | null;
  readonly cosineScore: number;
  readonly attributeAgreement: readonly SubstituteAttributeAgreement[];
  readonly relationLabel: 'substitute';
}

export interface SubstituteLookupResult {
  readonly substitutes: readonly SubstituteCandidate[];
  readonly anchor: {
    readonly handle: string;
    readonly type: string;
    readonly primaryAttribute: {
      readonly key: string;
      readonly value: string | number | boolean;
    } | null;
    readonly source: 'top-1-metadata';
  } | null;
  readonly note: string | null;
}

type StockStatus = 'exact' | 'orderable' | 'pending' | 'unavailable';

interface ProductSubstituteLookupToolArgs {
  readonly productQuery: string;
  readonly stockStatus: StockStatus;
}

export class ProductSubstituteLookupTool implements ToolRegistry {
  private readonly definition: ToolDefinition = {
    name: TOOL_NAME,
    description:
      "Look up in-stock substitutes when NFCS doesn't stock the queried product. Anchors on the top-1 retrieval result's product type and primary attribute (form for Feed, cut_type for Haylage, material for Bedding, target_concern for Supplements, fit for Outerwear). Returns 0-3 ranked substitute candidates. Runs only when product.stock_lookup returned non-exact.",
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        productQuery: {
          type: 'string',
          description:
            'Canonical product-string extracted from the customer query. Same shape as the input to product.stock_lookup.',
          minLength: 1,
          maxLength: MAX_PRODUCT_QUERY_LENGTH,
        },
        stockStatus: {
          type: 'string',
          description:
            "The originating stock_lookup call's status. When 'exact', this tool returns no substitutes.",
          enum: ['exact', 'orderable', 'pending', 'unavailable'],
        },
      },
      required: ['productQuery', 'stockStatus'],
    },
  };

  constructor(private readonly denseRetriever: Retriever) {}

  list(): readonly ToolDefinition[] {
    return [this.definition];
  }

  async invoke(call: ToolInvocation, signal?: AbortSignal): Promise<ToolResult> {
    if (call.name !== TOOL_NAME) {
      return {
        ok: false,
        error: `tool not found: ${call.name} (this registry only serves ${TOOL_NAME})`,
        retryable: false,
      };
    }

    const argsValidation = validateArgs(call.args);
    if (!argsValidation.ok) {
      return { ok: false, error: argsValidation.error, retryable: false };
    }
    const { productQuery, stockStatus } = argsValidation.value;

    if (stockStatus === 'exact') {
      const value: SubstituteLookupResult = {
        substitutes: [],
        anchor: null,
        note: 'stock is exact — substitute reasoning skipped',
      };
      return { ok: true, value };
    }

    const matches = await this.denseRetriever.retrieve({
      text: productQuery,
      topK: RETRIEVAL_TOP_K,
      filters: { content_type: 'product' },
    });
    if (signal?.aborted) {
      return { ok: false, error: 'aborted before result assembly', retryable: true };
    }

    if (matches.length === 0) {
      const value: SubstituteLookupResult = {
        substitutes: [],
        anchor: null,
        note: 'retriever returned no candidates',
      };
      return { ok: true, value };
    }

    const anchorChunk = matches[0];
    if (!anchorChunk) {
      const value: SubstituteLookupResult = {
        substitutes: [],
        anchor: null,
        note: 'retriever returned no candidates',
      };
      return { ok: true, value };
    }
    const anchorType = readStringMetadata(anchorChunk.metadata, 'type');
    const anchorHandle = readStringMetadata(anchorChunk.metadata, 'handle');
    if (!anchorType || !anchorHandle) {
      const value: SubstituteLookupResult = {
        substitutes: [],
        anchor: null,
        note: 'anchor missing type or handle metadata',
      };
      return { ok: true, value };
    }

    // Read primary attribute for observability, but do NOT filter
    // on it. Smoke on case 022 showed the anchor's own extracted
    // attribute can be wrong (ADR-0004 quality); filtering on it
    // removed valid substitutes. Roadmap item to revisit when
    // extraction quality improves.
    const primaryKey = SUBSTITUTE_PRIMARY_ATTRIBUTE[anchorType] ?? null;
    const anchorPrimaryValue = primaryKey
      ? readExtractedAttributeValue(anchorChunk.metadata, primaryKey)
      : null;
    const anchorRecord = {
      handle: anchorHandle,
      type: anchorType,
      primaryAttribute:
        primaryKey && anchorPrimaryValue !== null
          ? { key: primaryKey, value: anchorPrimaryValue }
          : null,
      source: 'top-1-metadata' as const,
    };

    // Build candidate list. Include the anchor itself — the top-1
    // dense hit IS the closest in-corpus product, therefore the
    // primary substitute. Rule: same `type` as the anchor.
    const candidates: SubstituteCandidate[] = [];
    for (let i = 0; i < matches.length; i++) {
      const chunk = matches[i];
      if (!chunk) continue;
      const candType = readStringMetadata(chunk.metadata, 'type');
      const candHandle = readStringMetadata(chunk.metadata, 'handle');
      if (!candType || !candHandle) continue;
      if (candType !== anchorType) continue;
      const candValue = primaryKey ? readExtractedAttributeValue(chunk.metadata, primaryKey) : null;

      const agreements: SubstituteAttributeAgreement[] =
        primaryKey !== null
          ? [
              {
                key: primaryKey,
                queryValue: anchorPrimaryValue,
                candidateValue: candValue,
                matches: anchorPrimaryValue !== null && candValue === anchorPrimaryValue,
                primary: true,
              },
            ]
          : [];
      candidates.push({
        chunkId: chunk.chunkId,
        handle: candHandle,
        title: readStringMetadata(chunk.metadata, 'title'),
        vendor: readStringMetadata(chunk.metadata, 'vendor'),
        priceMin: readNumberMetadata(chunk.metadata, 'price_min'),
        priceMax: readNumberMetadata(chunk.metadata, 'price_max'),
        cosineScore: chunk.score,
        attributeAgreement: agreements,
        relationLabel: 'substitute',
      });
    }

    // Sort: same-vendor beats cross-vendor, then cosine desc, then
    // chunk-id lex (deterministic ties).
    const anchorVendor = readStringMetadata(anchorChunk.metadata, 'vendor');
    candidates.sort((a, b) => {
      const aSame = anchorVendor !== null && a.vendor === anchorVendor ? 1 : 0;
      const bSame = anchorVendor !== null && b.vendor === anchorVendor ? 1 : 0;
      if (aSame !== bSame) return bSame - aSame;
      if (a.cosineScore !== b.cosineScore) return b.cosineScore - a.cosineScore;
      return a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0;
    });

    const value: SubstituteLookupResult = {
      substitutes: candidates.slice(0, MAX_SUBSTITUTES),
      anchor: anchorRecord,
      note: null,
    };
    return { ok: true, value };
  }
}

// ---------- helpers ----------

function validateArgs(
  args: Readonly<Record<string, unknown>>,
): { ok: true; value: ProductSubstituteLookupToolArgs } | { ok: false; error: string } {
  const productQuery = args['productQuery'];
  if (typeof productQuery !== 'string' || productQuery.trim().length === 0) {
    return { ok: false, error: 'productQuery is required and must be a non-empty string' };
  }
  if (productQuery.length > MAX_PRODUCT_QUERY_LENGTH) {
    return {
      ok: false,
      error: `productQuery too long (${productQuery.length} > ${MAX_PRODUCT_QUERY_LENGTH})`,
    };
  }
  const stockStatus = args['stockStatus'];
  if (
    stockStatus !== 'exact' &&
    stockStatus !== 'orderable' &&
    stockStatus !== 'pending' &&
    stockStatus !== 'unavailable'
  ) {
    return {
      ok: false,
      error:
        "stockStatus is required and must be one of 'exact' | 'orderable' | 'pending' | 'unavailable'",
    };
  }
  return { ok: true, value: { productQuery, stockStatus } };
}

function readStringMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | null {
  if (!metadata) return null;
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumberMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | null {
  if (!metadata) return null;
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readExtractedAttributeValue(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | number | boolean | null {
  if (!metadata) return null;
  const raw = metadata['extracted_attributes'];
  if (!Array.isArray(raw)) return null;
  for (const entry of raw as ExtractedAttributeValue[]) {
    if (entry && entry.key === key) {
      const v = entry.value;
      if (v === null) return null;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
      return null;
    }
  }
  return null;
}

// Test-only helper — exported so unit tests can construct a chunk
// with the right metadata shape without duplicating the reader.
export const __testing = { readExtractedAttributeValue };
