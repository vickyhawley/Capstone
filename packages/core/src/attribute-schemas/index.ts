/**
 * Attribute schema registry. Keyed by product type — the exact string
 * that appears in the catalogue CSV's `Type` column.
 *
 * Extractor behaviour when the product type has no schema entry: skip
 * the product with a logged warning rather than guess. Better to leave
 * a product without extracted attributes than to run a schema-mismatched
 * extraction against it.
 */

import { beddingSchema } from './bedding.js';
import { feedSchema } from './feed.js';
import { haylageSchema } from './haylage.js';
import { outerwearSchema } from './outerwear.js';
import { supplementsSchema } from './supplements.js';

export type {
  AttributeDefinition,
  AttributeSchema,
  AttributeType,
  ExtractedAttribute,
  SourceSpan,
} from './types.js';

export { beddingSchema, feedSchema, haylageSchema, outerwearSchema, supplementsSchema };

import type { AttributeSchema } from './types.js';

const REGISTRY: ReadonlyMap<string, AttributeSchema> = new Map([
  [feedSchema.productType, feedSchema],
  [beddingSchema.productType, beddingSchema],
  [haylageSchema.productType, haylageSchema],
  [supplementsSchema.productType, supplementsSchema],
  [outerwearSchema.productType, outerwearSchema],
]);

export function getAttributeSchema(productType: string): AttributeSchema | null {
  return REGISTRY.get(productType) ?? null;
}

export function listAttributeSchemas(): readonly AttributeSchema[] {
  return Array.from(REGISTRY.values());
}
