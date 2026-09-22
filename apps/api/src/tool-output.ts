/**
 * Extractors + URL builders shared between the JSON `/api/answer`
 * route and the SSE `/api/answer/stream` route. Both routes take
 * the tool loop's `toolInvocations` and surface a subset on the
 * response — same shape, same rules, one place to change.
 *
 * All extractors follow two rules (per the JSON route's original
 * shape contract):
 *   1. Unknown shapes degrade to empty/null, never throw.
 *   2. Tool name is the switch — rename a tool → update here.
 */

export interface ToolInvocationLite {
  readonly call: { readonly name: string };
  readonly result: { readonly ok: boolean; readonly value?: unknown };
}

export interface ProductLink {
  readonly handle: string;
  readonly title: string | null;
  readonly url: string;
  /** Price range from the ingested chunk metadata. Both null when
   *  the tool didn't surface prices (matched=null branches on
   *  stock_lookup, or substitute candidate without metadata). Same
   *  value when the product has a single price variant. Formatted
   *  on the client — the API returns raw numbers. */
  readonly priceMin: number | null;
  readonly priceMax: number | null;
}

export type DeliveryZoneStatus = 'within_radius' | 'defer_to_staff';

const STOREFRONT_BASE_URL_DEFAULT = 'https://newforestcountrystore.co.uk';

export function storefrontBaseUrl(): string {
  const raw = process.env['NFCS_STOREFRONT_BASE_URL']?.trim();
  const base = raw && raw.length > 0 ? raw : STOREFRONT_BASE_URL_DEFAULT;
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

export function productUrl(handle: string): string {
  return `${storefrontBaseUrl()}/products/${encodeURIComponent(handle)}`;
}

export function extractSubstituteHandles(
  invocations: readonly ToolInvocationLite[],
): readonly string[] {
  const substituteInv = invocations.find(
    (inv) => inv.call.name === 'product.substitute_lookup' && inv.result.ok,
  );
  if (!substituteInv) return [];
  const value = substituteInv.result.value as
    | { readonly substitutes?: readonly { readonly handle?: unknown }[] }
    | undefined;
  const substitutes = value?.substitutes;
  if (!Array.isArray(substitutes)) return [];
  return substitutes
    .map((s) => (typeof s?.handle === 'string' ? s.handle : null))
    .filter((h): h is string => h !== null);
}

export function extractDeliveryZoneStatus(
  invocations: readonly ToolInvocationLite[],
): DeliveryZoneStatus | null {
  const deliveryInv = invocations.find(
    (inv) => inv.call.name === 'logistics.delivery_zone' && inv.result.ok,
  );
  if (!deliveryInv) return null;
  const value = deliveryInv.result.value as { readonly status?: unknown } | undefined;
  const status = value?.status;
  if (status === 'within_radius' || status === 'defer_to_staff') return status;
  return null;
}

function readOptionalNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function extractProductLinks(
  invocations: readonly ToolInvocationLite[],
): readonly ProductLink[] {
  const links: ProductLink[] = [];
  const seen = new Set<string>();
  const push = (
    handle: unknown,
    title: unknown,
    priceMin: unknown,
    priceMax: unknown,
  ): void => {
    if (typeof handle !== 'string' || handle.length === 0) return;
    if (seen.has(handle)) return;
    seen.add(handle);
    links.push({
      handle,
      title: typeof title === 'string' && title.length > 0 ? title : null,
      url: productUrl(handle),
      priceMin: readOptionalNumber(priceMin),
      priceMax: readOptionalNumber(priceMax),
    });
  };

  const stockInv = invocations.find(
    (inv) => inv.call.name === 'product.stock_lookup' && inv.result.ok,
  );
  if (stockInv) {
    const value = stockInv.result.value as
      | {
          readonly matchedHandle?: unknown;
          readonly matchedTitle?: unknown;
          readonly matchedPriceMin?: unknown;
          readonly matchedPriceMax?: unknown;
        }
      | undefined;
    push(
      value?.matchedHandle,
      value?.matchedTitle,
      value?.matchedPriceMin,
      value?.matchedPriceMax,
    );
  }

  const substituteInv = invocations.find(
    (inv) => inv.call.name === 'product.substitute_lookup' && inv.result.ok,
  );
  if (substituteInv) {
    const value = substituteInv.result.value as
      | {
          readonly substitutes?: readonly {
            readonly handle?: unknown;
            readonly title?: unknown;
            readonly priceMin?: unknown;
            readonly priceMax?: unknown;
          }[];
        }
      | undefined;
    const substitutes = value?.substitutes;
    if (Array.isArray(substitutes)) {
      for (const s of substitutes) {
        push(s?.handle, s?.title, s?.priceMin, s?.priceMax);
      }
    }
  }

  return links;
}

/**
 * Citation attached to a response. Matches the Python eval schema
 * `Citation` (`evals/groundwork_evals/schema.py`). `chunk_id` is the
 * only field the `groundedness` and `citation_accuracy` metrics read;
 * `document_id` is optional and surfaced when the tool result carries
 * it so the eval judge (and human reviewers) can trace back to source.
 */
export interface Citation {
  readonly chunk_id: string;
  readonly document_id: string | null;
}

/**
 * All chunk IDs the tools retrieved during a turn. Consumed by the
 * `recall_at_k` and `retrieval_relevance` eval metrics. Over-collecting
 * here is safe — these metrics reward broad recall. Distinct from
 * `extractCitations` below, which reports the *primary* chunks the
 * answer is grounded on.
 */
export function extractRetrievedChunkIds(
  invocations: readonly ToolInvocationLite[],
): readonly string[] {
  const ids = new Set<string>();

  const stockInv = invocations.find(
    (inv) => inv.call.name === 'product.stock_lookup' && inv.result.ok,
  );
  if (stockInv) {
    const value = stockInv.result.value as
      | { readonly matchedChunkIds?: readonly unknown[] }
      | undefined;
    const chunks = value?.matchedChunkIds;
    if (Array.isArray(chunks)) {
      for (const c of chunks) {
        if (typeof c === 'string' && c.length > 0) ids.add(c);
      }
    }
  }

  const substituteInv = invocations.find(
    (inv) => inv.call.name === 'product.substitute_lookup' && inv.result.ok,
  );
  if (substituteInv) {
    const value = substituteInv.result.value as
      | { readonly substitutes?: readonly { readonly chunkId?: unknown }[] }
      | undefined;
    const subs = value?.substitutes;
    if (Array.isArray(subs)) {
      for (const s of subs) {
        if (typeof s?.chunkId === 'string' && s.chunkId.length > 0) ids.add(s.chunkId);
      }
    }
  }

  return [...ids];
}

/**
 * Citations for the response body. Reports only the PRIMARY chunk from
 * each retrieval-backed tool result — the top match from stock_lookup
 * and the top substitute from substitute_lookup. Deliberately narrower
 * than `extractRetrievedChunkIds` because the eval `groundedness`
 * metric scores `overlap / cited` — over-citing dilutes precision.
 * The narrow set represents "what actually influenced the answer" and
 * is a defensible interpretation of the AI Engineering Project brief's
 * "cite source doc IDs/titles" requirement.
 *
 * Rationale for not surfacing an LLM-emitted citation list: the
 * synthesizer prompt (see `packages/adapters/src/synthesis/openai-
 * synthesizer.ts`) already grounds against tool findings, and the top
 * chunk IS what the answer is built from. Adding an "emit-citations"
 * output step is a Sprint 5+ story if per-sentence attribution is
 * needed.
 */
export function extractCitations(
  invocations: readonly ToolInvocationLite[],
): readonly Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  const push = (chunkId: unknown, documentId: unknown = null): void => {
    if (typeof chunkId !== 'string' || chunkId.length === 0) return;
    if (seen.has(chunkId)) return;
    seen.add(chunkId);
    citations.push({
      chunk_id: chunkId,
      document_id: typeof documentId === 'string' && documentId.length > 0 ? documentId : null,
    });
  };

  const stockInv = invocations.find(
    (inv) => inv.call.name === 'product.stock_lookup' && inv.result.ok,
  );
  if (stockInv) {
    const value = stockInv.result.value as
      | { readonly matchedChunkIds?: readonly unknown[] }
      | undefined;
    const chunks = value?.matchedChunkIds;
    if (Array.isArray(chunks) && chunks.length > 0) {
      push(chunks[0]);
    }
  }

  const substituteInv = invocations.find(
    (inv) => inv.call.name === 'product.substitute_lookup' && inv.result.ok,
  );
  if (substituteInv) {
    const value = substituteInv.result.value as
      | { readonly substitutes?: readonly { readonly chunkId?: unknown }[] }
      | undefined;
    const subs = value?.substitutes;
    if (Array.isArray(subs) && subs.length > 0 && subs[0]) {
      push(subs[0].chunkId);
    }
  }

  return citations;
}

/**
 * Trace ID for a single request. Random hex, not a spec-compliant
 * UUID — scope is one turn's traces, doesn't need to be. Sprint 3
 * GW-25 may swap to a proper UUID when traces persist across turns.
 */
export function generateTraceId(): string {
  const hex = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
