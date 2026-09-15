/**
 * Attribute schemas for LLM extraction at ingest.
 *
 * See ADR-0004. Each product type has a schema listing the attributes
 * the extractor should look for. The schema is data, not code — a
 * strict shape the extractor prompts the LLM against and validates
 * the response against.
 *
 * A note on stability: schemas are versioned by hash. Changing a
 * schema (adding an attribute, tightening an enum) forces a re-extract
 * for products of that type. The `schemaVersion` field is computed
 * once per schema at load time by hashing the JSON representation.
 */

export type AttributeType = 'string' | 'number' | 'boolean' | 'enum';

export interface AttributeDefinition {
  readonly key: string;
  readonly displayName: string;
  readonly type: AttributeType;
  readonly unit?: string;
  readonly enumValues?: readonly string[];
  readonly promptGuidance: string;
}

export interface AttributeSchema {
  readonly productType: string;
  readonly attributes: readonly AttributeDefinition[];
}

/**
 * The shape the extractor emits per attribute. Two invariants,
 * checked in `packages/ingestion/src/attribute-extractor.ts`:
 *
 * 1. `value !== null && sourceSpan === null` is a hallucination.
 *    Dropped at write time, never stored.
 * 2. `value === null` is a true fact about the catalogue — the
 *    description does not support a value. The assistant abstains
 *    on questions about this attribute for this product.
 */
export interface SourceSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface ExtractedAttribute {
  readonly key: string;
  readonly value: string | number | boolean | null;
  readonly confidence: number;
  readonly sourceSpan: SourceSpan | null;
}
