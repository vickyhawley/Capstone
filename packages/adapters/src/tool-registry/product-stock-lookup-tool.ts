/**
 * ProductStockLookupTool. GW-20 / ADR-0016.
 *
 * The load-bearing product-intent tool. Answers "does NFCS stock X"
 * with three states:
 *
 *   - `exact`       — chunks table has a matching product-type chunk
 *                     whose top-1 hybrid score exceeds `minMatchScore`.
 *   - `orderable`   — no chunk match AND productQuery does not match
 *                     the SME-curated out-of-scope list. NFCS's core
 *                     value prop is "we don't stock it in-store but we
 *                     can order it in for you" — the default is
 *                     order-in-able.
 *   - `unavailable` — no chunk match AND productQuery matches the
 *                     out-of-scope list. The tool returns the entry's
 *                     `reason` as `outOfScopeReason`.
 *
 * See ADR-0016 for:
 *   - §1 chunks-as-catalogue reasoning + why not the `products` table.
 *   - §2 decision logic + result shape.
 *   - §3 `minMatchScore` — provisional 0.5 default until Story 4
 *        close-out measures a data-driven floor.
 *   - §5 error contract: infra failure throws; structured errors for
 *        arg validation failures.
 *   - §Framing note: this tool is NOT deterministic. It's hybrid
 *        retrieval with a threshold. The load-bearing claim is
 *        "stock status is sourced from the catalogue, not from model
 *        knowledge", not "deterministic".
 */

import { readFile } from 'node:fs/promises';

import type {
  Retriever,
  ToolDefinition,
  ToolInvocation,
  ToolRegistry,
  ToolResult,
} from '@groundwork/core';
import { parse as parseYaml } from 'yaml';

/**
 * Default `minMatchScore` — provisional per ADR-0016 §3. Conservative
 * on the safety axis: false-orderable ("we can source that") is a
 * customer-inconvenience failure; false-exact ("in stock") is a
 * promise-breaking failure. This floor tolerates the first while
 * defending against the second. Sprint 3 close-out either confirms,
 * tightens, or (if data justifies) loosens.
 */
export const DEFAULT_MIN_MATCH_SCORE = 0.5;

const TOOL_NAME = 'product.stock_lookup';

/** Max productQuery length. Longer than any real customer product-string
 *  by an order of magnitude; anything above this is either an entire
 *  message body or a malformed call. Structured error rather than
 *  attempting retrieval on it. */
const MAX_PRODUCT_QUERY_LENGTH = 200;

/** Cap on returned matchedChunkIds. Per ADR-0016 §6 — traces stay
 *  small; synthesis reads chunk bodies via a separate lookup, so the
 *  span doesn't need to carry them. */
const MAX_MATCHED_CHUNK_IDS = 5;

/** Retrieval top-K for the catalogue lookup. Enough headroom to find
 *  the right chunk when adjacent chunks score close; less than the
 *  general retriever top-K (which serves synthesis, not the tool). */
const RETRIEVAL_TOP_K = 5;

export type StockStatus = 'exact' | 'orderable' | 'unavailable';

export interface StockLookupResult {
  readonly status: StockStatus;
  readonly matchedChunkIds: readonly string[];
  readonly matchedHandle: string | null;
  readonly matchedTitle: string | null;
  readonly outOfScopeReason: string | null;
  readonly matchScore: number | null;
}

interface OutOfScopeEntry {
  readonly name: string;
  readonly matcher: 'substring';
  readonly pattern: string;
  readonly reason: string;
  readonly provisional?: 'test-derived';
  readonly provenance?: string;
}

interface OutOfScopeFile {
  readonly entries: readonly OutOfScopeEntry[];
}

interface ProductStockLookupToolArgs {
  readonly productQuery: string;
  /** Overrides the default floor. Only the smoke script sets this;
   *  no customer-reaching path passes `null` — see ADR-0016 §3. */
  readonly minMatchScore?: number | null;
}

export class ProductStockLookupTool implements ToolRegistry {
  private readonly definition: ToolDefinition = {
    name: TOOL_NAME,
    description:
      'Look up whether NFCS stocks a specific product. Returns three-state stock: exact (held in-store), orderable (not held but within sourcing scope), unavailable (out of sourcing scope).',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        productQuery: {
          type: 'string',
          description:
            'Canonical product-string extracted from the customer query. Case-preserved; brand names retained.',
          minLength: 1,
          maxLength: MAX_PRODUCT_QUERY_LENGTH,
        },
        minMatchScore: {
          type: ['number', 'null'],
          description:
            'Optional override for the exact-match threshold. Omit in customer-facing paths; the tool uses its safe default.',
          minimum: 0,
          maximum: 1,
        },
      },
      required: ['productQuery'],
    },
  };

  constructor(
    private readonly retriever: Retriever,
    private readonly outOfScope: readonly OutOfScopeEntry[],
  ) {}

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
    const { productQuery, minMatchScore } = argsValidation.value;

    // Effective threshold: caller-supplied override wins; explicit null
    // means "characterisation mode" (smoke only); undefined means use
    // the safe default. See ADR-0016 §3.
    const effectiveMinScore = minMatchScore === undefined ? DEFAULT_MIN_MATCH_SCORE : minMatchScore;

    // Retrieval — filtered to product-type chunks. The retriever port
    // takes filters as scalar/bool records; content_type is a scalar
    // string on the underlying documents row.
    const matches = await this.retriever.retrieve({
      text: productQuery,
      topK: RETRIEVAL_TOP_K,
      filters: { content_type: 'product' },
    });
    if (signal?.aborted) {
      return { ok: false, error: 'aborted before result assembly', retryable: true };
    }

    const topScore = matches[0]?.score ?? null;
    const passesFloor =
      matches.length > 0 &&
      matches[0] !== undefined &&
      (effectiveMinScore === null || matches[0].score >= effectiveMinScore);

    if (passesFloor && matches[0]) {
      const top = matches[0];
      const value: StockLookupResult = {
        status: 'exact',
        matchedChunkIds: matches.slice(0, MAX_MATCHED_CHUNK_IDS).map((m) => m.chunkId),
        matchedHandle: readStringMetadata(top.metadata, 'handle'),
        // Title lives on the document, not the chunk. The retriever
        // may or may not surface it via metadata; when absent, null.
        matchedTitle: readStringMetadata(top.metadata, 'title'),
        outOfScopeReason: null,
        matchScore: top.score,
      };
      return { ok: true, value };
    }

    // No catalogue match at the threshold. Check the out-of-scope list.
    const scopeHit = matchOutOfScope(productQuery, this.outOfScope);
    if (scopeHit) {
      const value: StockLookupResult = {
        status: 'unavailable',
        matchedChunkIds: [],
        matchedHandle: null,
        matchedTitle: null,
        outOfScopeReason: scopeHit.reason,
        matchScore: topScore,
      };
      return { ok: true, value };
    }

    // Not held, not out-of-scope → orderable. NFCS's default posture.
    const value: StockLookupResult = {
      status: 'orderable',
      matchedChunkIds: [],
      matchedHandle: null,
      matchedTitle: null,
      outOfScopeReason: null,
      matchScore: topScore,
    };
    return { ok: true, value };
  }
}

/**
 * Load and parse the out-of-scope YAML file. Throws on infra failure
 * (file missing, unparseable) — GW-26's circuit breaker catches at the
 * request boundary. Callers should load once at composition-root, not
 * per-invocation.
 */
export async function loadOutOfScopeList(path: string): Promise<readonly OutOfScopeEntry[]> {
  const raw = await readFile(path, 'utf8');
  const parsed = parseYaml(raw) as OutOfScopeFile | null;
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error(`out-of-scope YAML at ${path} did not contain a top-level 'entries' array`);
  }
  // Structural check — a malformed entry today is a shipping bug we
  // want loud, not a silent skip.
  for (const [i, entry] of parsed.entries.entries()) {
    if (
      typeof entry.name !== 'string' ||
      typeof entry.pattern !== 'string' ||
      typeof entry.reason !== 'string' ||
      entry.matcher !== 'substring'
    ) {
      throw new Error(
        `out-of-scope YAML entry ${i} malformed: ${JSON.stringify(entry)}. Required: {name: string, matcher: 'substring', pattern: string, reason: string}.`,
      );
    }
  }
  return parsed.entries;
}

// ---------- helpers ----------

function validateArgs(
  args: Readonly<Record<string, unknown>>,
): { ok: true; value: ProductStockLookupToolArgs } | { ok: false; error: string } {
  const productQuery = args['productQuery'];
  if (typeof productQuery !== 'string' || productQuery.trim().length === 0) {
    return {
      ok: false,
      error: `productQuery is required and must be a non-empty string (got ${describe(productQuery)})`,
    };
  }
  if (productQuery.length > MAX_PRODUCT_QUERY_LENGTH) {
    return {
      ok: false,
      error: `productQuery exceeds max length of ${MAX_PRODUCT_QUERY_LENGTH} characters (got ${productQuery.length})`,
    };
  }
  const minRaw = args['minMatchScore'];
  let minMatchScore: number | null | undefined;
  if (minRaw === undefined) {
    minMatchScore = undefined;
  } else if (minRaw === null) {
    minMatchScore = null;
  } else if (typeof minRaw === 'number' && Number.isFinite(minRaw)) {
    minMatchScore = minRaw;
  } else {
    return {
      ok: false,
      error: `minMatchScore, when provided, must be a finite number or null (got ${describe(minRaw)})`,
    };
  }
  return {
    ok: true,
    value: minMatchScore === undefined ? { productQuery } : { productQuery, minMatchScore },
  };
}

function readStringMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | null {
  if (!metadata) return null;
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function matchOutOfScope(
  productQuery: string,
  entries: readonly OutOfScopeEntry[],
): OutOfScopeEntry | null {
  const lowered = productQuery.toLowerCase();
  for (const entry of entries) {
    if (entry.matcher === 'substring' && lowered.includes(entry.pattern.toLowerCase())) {
      return entry;
    }
  }
  return null;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value}"`;
  return typeof value;
}
