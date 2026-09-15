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
 * 2. `sourceSpan.text` must appear as a substring of the source.
 *    Offsets are computed server-side from `source.indexOf(text)`; the
 *    model's reported offsets are ignored on purpose. See
 *    `coerceSourceSpan` below for the reasoning (early run showed 296
 *    of 303 drops were false positives from strict offset equality
 *    despite the model quoting the right words).
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

/**
 * Verify by substring containment, not by offset equality. The model
 * reliably quotes source text but does not reliably count characters —
 * an early run showed 296 of 303 attributes dropping to
 * `source-span-mismatch` despite the model quoting the right words.
 * ADR-0004's grounding contract is "the value came from a substring of
 * the description", not "the model correctly counted UTF-16 code units";
 * the check now matches the contract. Offsets are computed server-side
 * from the verified text so downstream consumers still get precise
 * spans.
 *
 * The model's reported offsets are ignored on purpose. Requiring `text`
 * to appear in `source` is stricter than requiring paraphrase-safe
 * embedding: text must match verbatim, whitespace and casing included.
 * Paraphrase (e.g. "20,000 mm" when source says "20000mm") still fails
 * the check as it should.
 */
function coerceSourceSpan(raw: unknown, source: string): SourceSpan | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (!isRecord(raw)) {
    return null;
  }
  const text = raw['text'];
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  const foundStart = source.indexOf(text);
  if (foundStart < 0) {
    return null;
  }
  return { text, start: foundStart, end: foundStart + text.length };
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
