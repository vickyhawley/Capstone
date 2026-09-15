/**
 * Attribute extractor validation.
 *
 * The LLM call itself lives in the runner (persistence commit); this
 * module owns the validation discipline that ADR-0004 requires. Given
 * a raw JSON response from the model plus the source description it
 * came from, produce a list of `ExtractedAttribute`s with three
 * invariants enforced:
 *
 * 1. `value !== null && sourceSpan === null` is a hallucination.
 *    Dropped, never stored. Recorded in the drop-report so ingest can
 *    fail if the count is non-zero (see ADR-0004's "failure mode to
 *    watch, named explicitly").
 * 2. `sourceSpan !== null` must be a substring of the source at
 *    `[start, end)`. If the model reports a span that doesn't match
 *    the source, the attribute is dropped.
 * 3. Keys not in the schema are silently dropped (the extractor was
 *    invented an attribute the schema does not know about; not
 *    stored to keep the metadata shape closed).
 *
 * The drop report is not a warning to eyeball; it is a first-class
 * output. The runner writes it alongside the extracted attributes so
 * downstream tooling (and reviewers) can see what the model tried to
 * do and why the guardrail caught it.
 */

import type { AttributeSchema, ExtractedAttribute, SourceSpan } from '@groundwork/core';

export type DropReason =
  | 'value-without-source-span'
  | 'source-span-mismatch'
  | 'key-not-in-schema'
  | 'invalid-shape';

export interface DroppedAttribute {
  readonly key: string;
  readonly reason: DropReason;
  readonly raw: unknown;
}

export interface ExtractionResult {
  readonly attributes: readonly ExtractedAttribute[];
  readonly drops: readonly DroppedAttribute[];
}

interface RawAttribute {
  readonly key?: unknown;
  readonly value?: unknown;
  readonly confidence?: unknown;
  readonly source_span?: unknown;
}

interface RawResponse {
  readonly attributes?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceSourceSpan(raw: unknown, source: string): SourceSpan | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (!isRecord(raw)) {
    return null;
  }
  const text = raw['text'];
  const start = raw['start'];
  const end = raw['end'];
  if (typeof text !== 'string' || typeof start !== 'number' || typeof end !== 'number') {
    return null;
  }
  if (start < 0 || end > source.length || start >= end) {
    return null;
  }
  if (source.slice(start, end) !== text) {
    return null;
  }
  return { text, start, end };
}

function coerceValue(raw: unknown, attributeType: string): string | number | boolean | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (attributeType === 'number') {
    return typeof raw === 'number' ? raw : null;
  }
  if (attributeType === 'boolean') {
    return typeof raw === 'boolean' ? raw : null;
  }
  return typeof raw === 'string' ? raw : null;
}

export function parseExtractionResponse(
  rawJson: string,
  schema: AttributeSchema,
  source: string,
): ExtractionResult {
  const attributes: ExtractedAttribute[] = [];
  const drops: DroppedAttribute[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      attributes: [],
      drops: [{ key: '<root>', reason: 'invalid-shape', raw: rawJson }],
    };
  }

  if (!isRecord(parsed)) {
    return {
      attributes: [],
      drops: [{ key: '<root>', reason: 'invalid-shape', raw: parsed }],
    };
  }
  const response = parsed as RawResponse;
  const rawAttrs = response.attributes;
  if (!Array.isArray(rawAttrs)) {
    return {
      attributes: [],
      drops: [{ key: '<root>', reason: 'invalid-shape', raw: parsed }],
    };
  }

  const schemaByKey = new Map(schema.attributes.map((attr) => [attr.key, attr] as const));

  for (const rawAttrCandidate of rawAttrs) {
    if (!isRecord(rawAttrCandidate)) {
      drops.push({ key: '<unknown>', reason: 'invalid-shape', raw: rawAttrCandidate });
      continue;
    }
    const rawAttr = rawAttrCandidate as RawAttribute;
    const key = typeof rawAttr.key === 'string' ? rawAttr.key : '<missing>';

    const definition = schemaByKey.get(key);
    if (!definition) {
      drops.push({ key, reason: 'key-not-in-schema', raw: rawAttr });
      continue;
    }

    const value = coerceValue(rawAttr.value, definition.type);
    const rawSpan = rawAttr.source_span;
    const sourceSpan = coerceSourceSpan(rawSpan, source);

    if (value !== null && sourceSpan === null) {
      const wasProvided = rawSpan !== null && rawSpan !== undefined;
      drops.push({
        key,
        reason: wasProvided ? 'source-span-mismatch' : 'value-without-source-span',
        raw: rawAttr,
      });
      continue;
    }

    const confidence =
      typeof rawAttr.confidence === 'number' && rawAttr.confidence >= 0 && rawAttr.confidence <= 1
        ? rawAttr.confidence
        : 0;

    attributes.push({ key, value, confidence, sourceSpan });
  }

  return { attributes, drops };
}
