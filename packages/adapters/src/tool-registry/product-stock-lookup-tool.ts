/**
 * ProductStockLookupTool. GW-20 / ADR-0016.
 *
 * The load-bearing product-intent tool. Answers "does NFCS stock X"
 * with four states (SME correction 2026-09-17 — original three-state
 * model didn't have a home for "not-yet, committed to a specific
 * pre-condition"; see ADR-0016 §"Why pending is a distinct status"):
 *
 *   - `exact`       — chunks table has a matching product-type chunk
 *                     whose top-1 hybrid score exceeds `minMatchScore`.
 *   - `pending`     — no chunk match AND productQuery matches an
 *                     entry in `nfcs-pending.yaml` (temporary
 *                     pre-condition, e.g. wormers pending BETA
 *                     membership, fencing pending unit-F1 lease).
 *                     The tool returns the entry's `reason` as
 *                     `pendingReason`.
 *   - `orderable`   — no chunk match, not pending, not out-of-scope.
 *                     NFCS's default posture — the shop can source
 *                     on customer request.
 *   - `unavailable` — no chunk match AND productQuery matches an
 *                     entry in `nfcs-out-of-scope.yaml` (permanent
 *                     commercial won't-stock, e.g. Ariat / LeMieux
 *                     because Aivly stocks them locally). The tool
 *                     returns the entry's `reason` as
 *                     `outOfScopeReason`.
 *
 * Ordering: `exact` beats `unavailable` beats `pending` beats
 * `orderable` — a shipped product overrides policy; a permanent
 * brand block overrides a temporary category pending; a committed
 * pre-condition overrides the generic sourcing offer.
 *
 * See ADR-0016 for:
 *   - §1 chunks-as-catalogue reasoning + two-file override model.
 *   - §2 decision logic + result shape + four-state argument.
 *   - §3 `minMatchScore` — provisional 0.5 default until Story 4
 *        close-out measures a data-driven floor.
 *   - §5 error contract: infra failure throws; structured errors for
 *        arg validation failures.
 *   - §Framing note: this tool is NOT deterministic. It's hybrid
 *        retrieval with a threshold. The load-bearing claim is
 *        "stock status is sourced from the catalogue, not from model
 *        knowledge", not "deterministic".
 *   - §Prediction: case 008 (electric fencing) is expected to flip
 *        from `pending` to `exact` in mid-Sprint 3 when unit F1
 *        opens. Deterministic chunk IDs (ADR-0013) make the
 *        re-ingest cheap — the Story-1 payoff.
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
 * Default `minMatchScore` — cosine-similarity scale, applied to the
 * top-1 result from the dense retriever (NOT the RRF-fused hybrid
 * output). See ADR-0016 §3 for the rationale — RRF scores are
 * ordinal and don't separate exact from orderable; cosine is metric
 * and carries the confidence signal.
 *
 * Value 0.5 is provisional pending the Story-4 cosine-space
 * characterisation. Conservative on the safety axis: false-orderable
 * ("we can source that") is a customer-inconvenience failure;
 * false-exact ("in stock") is a promise-breaking failure. This floor
 * tolerates the first while defending against the second.
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

export type StockStatus = 'exact' | 'orderable' | 'pending' | 'unavailable';

export interface StockLookupResult {
  readonly status: StockStatus;
  readonly matchedChunkIds: readonly string[];
  readonly matchedHandle: string | null;
  readonly matchedTitle: string | null;
  readonly outOfScopeReason: string | null;
  readonly pendingReason: string | null;
  readonly matchScore: number | null;
}

/**
 * A status-override entry from either `nfcs-out-of-scope.yaml` or
 * `nfcs-pending.yaml`. Same shape either way; the file the entry
 * came from determines the status the tool returns on match.
 */
export interface StatusOverrideEntry {
  readonly name: string;
  readonly matcher: 'substring';
  readonly pattern: string;
  readonly reason: string;
  readonly provenance?: string;
}

interface StatusOverrideFile {
  readonly entries: readonly StatusOverrideEntry[];
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
      "Look up whether NFCS stocks a specific product. Returns four-state stock: exact (held in-store), pending (not currently held, committed to a specific pre-condition), orderable (not held but shop can source on request), unavailable (permanent commercial won't-stock — see local stockist).",
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

  /**
   * @param retriever       Ordered chunk source — typically a
   *   `HybridRetriever` composing dense + sparse via RRF. Owns
   *   ordering and citation retrieval. Its top-1 score is NOT read
   *   for confidence gating (RRF is ordinal; see ADR-0016 §3).
   * @param denseRetriever  Confidence-signal source — typically the
   *   same `PgvectorDenseRetriever` that feeds `retriever`. Its
   *   top-1 cosine score is compared against `minMatchScore`. In
   *   production the two retrievers share an OpenAI client so the
   *   duplicate embed call is server-side cached; in tests, callers
   *   can pass the same stub for both.
   * @param outOfScope      Permanent brand won't-stock overrides
   *   (`data/nfcs-out-of-scope.yaml`).
   * @param pending         Temporary pre-condition overrides
   *   (`data/nfcs-pending.yaml`).
   */
  constructor(
    private readonly retriever: Retriever,
    private readonly denseRetriever: Retriever,
    private readonly outOfScope: readonly StatusOverrideEntry[],
    private readonly pending: readonly StatusOverrideEntry[] = [],
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

    // Retrieval — filtered to product-type chunks. Two concurrent
    // calls: the hybrid retriever owns ordering + chunk IDs, the
    // dense retriever supplies the top-1 cosine score for the
    // confidence floor. RRF scores are ordinal and can't gate
    // confidence (ADR-0016 §3); cosine is the metric signal.
    const [matches, denseMatches] = await Promise.all([
      this.retriever.retrieve({
        text: productQuery,
        topK: RETRIEVAL_TOP_K,
        filters: { content_type: 'product' },
      }),
      this.denseRetriever.retrieve({
        text: productQuery,
        topK: 1,
        filters: { content_type: 'product' },
      }),
    ]);
    if (signal?.aborted) {
      return { ok: false, error: 'aborted before result assembly', retryable: true };
    }

    // `matchScore` on the result is the cosine confidence — the
    // number the floor is applied against. Callers surfacing scores
    // for observability see cosine, not RRF, which is what the
    // threshold discipline in ADR-0016 §3 requires.
    const topScore = denseMatches[0]?.score ?? null;
    const passesFloor =
      matches.length > 0 &&
      matches[0] !== undefined &&
      topScore !== null &&
      (effectiveMinScore === null || topScore >= effectiveMinScore);

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
        pendingReason: null,
        matchScore: topScore,
      };
      return { ok: true, value };
    }

    // Ordering per ADR-0016 §2: unavailable beats pending beats
    // orderable. Check out-of-scope (permanent commercial won't-stock)
    // first, then pending (temporary pre-condition), then default to
    // orderable.
    const scopeHit = matchOverride(productQuery, this.outOfScope);
    if (scopeHit) {
      const value: StockLookupResult = {
        status: 'unavailable',
        matchedChunkIds: [],
        matchedHandle: null,
        matchedTitle: null,
        outOfScopeReason: scopeHit.reason,
        pendingReason: null,
        matchScore: topScore,
      };
      return { ok: true, value };
    }

    const pendingHit = matchOverride(productQuery, this.pending);
    if (pendingHit) {
      const value: StockLookupResult = {
        status: 'pending',
        matchedChunkIds: [],
        matchedHandle: null,
        matchedTitle: null,
        outOfScopeReason: null,
        pendingReason: pendingHit.reason,
        matchScore: topScore,
      };
      return { ok: true, value };
    }

    // Not held, not out-of-scope, not pending → orderable.
    // NFCS's default posture — shop can source on customer request.
    const value: StockLookupResult = {
      status: 'orderable',
      matchedChunkIds: [],
      matchedHandle: null,
      matchedTitle: null,
      outOfScopeReason: null,
      pendingReason: null,
      matchScore: topScore,
    };
    return { ok: true, value };
  }
}

/**
 * Load and parse a status-override YAML file. Both
 * `nfcs-out-of-scope.yaml` (brand won't-stock) and
 * `nfcs-pending.yaml` (temporary pre-condition) share this schema;
 * the file the entries come from determines the status the tool
 * returns on match. Throws on infra failure (file missing,
 * unparseable) — GW-26's circuit breaker catches at the request
 * boundary. Callers should load once at composition-root, not
 * per-invocation.
 */
export async function loadStatusOverrideList(
  path: string,
): Promise<readonly StatusOverrideEntry[]> {
  const raw = await readFile(path, 'utf8');
  const parsed = parseYaml(raw) as StatusOverrideFile | null;
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error(`status-override YAML at ${path} did not contain a top-level 'entries' array`);
  }
  for (const [i, entry] of parsed.entries.entries()) {
    if (
      typeof entry.name !== 'string' ||
      typeof entry.pattern !== 'string' ||
      typeof entry.reason !== 'string' ||
      entry.matcher !== 'substring'
    ) {
      throw new Error(
        `status-override YAML entry ${i} at ${path} is malformed: ${JSON.stringify(entry)}. Required: {name: string, matcher: 'substring', pattern: string, reason: string}.`,
      );
    }
  }
  return parsed.entries;
}

/**
 * @deprecated Use loadStatusOverrideList directly. Retained under
 * the previous name for compositional-root wiring landing in a
 * follow-up commit — will be removed in the next commit.
 */
export const loadOutOfScopeList = loadStatusOverrideList;

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

function matchOverride(
  productQuery: string,
  entries: readonly StatusOverrideEntry[],
): StatusOverrideEntry | null {
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
