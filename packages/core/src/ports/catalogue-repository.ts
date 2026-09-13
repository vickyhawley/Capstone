/**
 * CatalogueRepository port.
 *
 * Structured product data. Distinct from the Retriever: this is the
 * source of truth for facts (SKU, price, stock, dimensions), not for
 * unstructured content. Tools call this port; the LanguageModel never
 * does.
 *
 * Assumes:
 * - IDs are stable across sessions.
 * - `getStock` reflects current state at the time of the call, subject to
 *   the underlying store's consistency guarantees. Callers must treat any
 *   value as potentially stale by the time it reaches the user.
 * - Missing entities return `null`, not a thrown error.
 */
export interface Product {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly brand: string;
  readonly category: string;
  readonly description: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface ProductVariant {
  readonly id: string;
  readonly productId: string;
  readonly sku: string;
  readonly size?: string;
  readonly colour?: string;
  readonly priceMinorUnits: number;
  readonly currency: string;
}

export interface StockLevel {
  readonly variantId: string;
  readonly available: number;
  readonly asOf: string;
}

export interface CatalogueRepository {
  getProduct(id: string): Promise<Product | null>;
  listVariants(productId: string): Promise<readonly ProductVariant[]>;
  getStock(variantId: string): Promise<StockLevel | null>;
}
