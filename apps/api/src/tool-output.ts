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

export function extractProductLinks(
  invocations: readonly ToolInvocationLite[],
): readonly ProductLink[] {
  const links: ProductLink[] = [];
  const seen = new Set<string>();
  const push = (handle: unknown, title: unknown): void => {
    if (typeof handle !== 'string' || handle.length === 0) return;
    if (seen.has(handle)) return;
    seen.add(handle);
    links.push({
      handle,
      title: typeof title === 'string' && title.length > 0 ? title : null,
      url: productUrl(handle),
    });
  };

  const stockInv = invocations.find(
    (inv) => inv.call.name === 'product.stock_lookup' && inv.result.ok,
  );
  if (stockInv) {
    const value = stockInv.result.value as
      | { readonly matchedHandle?: unknown; readonly matchedTitle?: unknown }
      | undefined;
    push(value?.matchedHandle, value?.matchedTitle);
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
          }[];
        }
      | undefined;
    const substitutes = value?.substitutes;
    if (Array.isArray(substitutes)) {
      for (const s of substitutes) {
        push(s?.handle, s?.title);
      }
    }
  }

  return links;
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
