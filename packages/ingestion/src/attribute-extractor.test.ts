import { describe, expect, it } from 'vitest';

import { outerwearSchema } from '@groundwork/core';

import { parseExtractionResponse } from './attribute-extractor.js';

const source =
  'The Aura is a lightweight turnout with a 20000mm waterproof rating and 32000 g/m²/24hr breathability.';

function findSpan(text: string, needle: string) {
  const start = text.indexOf(needle);
  return { text: needle, start, end: start + needle.length };
}

describe('parseExtractionResponse', () => {
  it('accepts a valid attribute with a matching source span', () => {
    const span = findSpan(source, '20000mm');
    const raw = JSON.stringify({
      attributes: [
        {
          key: 'waterproof_mm',
          value: 20000,
          confidence: 0.95,
          source_span: span,
        },
      ],
    });
    const result = parseExtractionResponse(raw, outerwearSchema, source);
    expect(result.drops).toHaveLength(0);
    expect(result.attributes).toEqual([
      {
        key: 'waterproof_mm',
        value: 20000,
        confidence: 0.95,
        sourceSpan: { text: '20000mm', start: span.start, end: span.end },
      },
    ]);
  });

  it('accepts null value with null source span (unsupported fact)', () => {
    const raw = JSON.stringify({
      attributes: [{ key: 'insulation_g', value: null, confidence: 0.5, source_span: null }],
    });
    const result = parseExtractionResponse(raw, outerwearSchema, source);
    expect(result.drops).toHaveLength(0);
    expect(result.attributes[0]).toMatchObject({
      key: 'insulation_g',
      value: null,
      sourceSpan: null,
    });
  });

  it('drops a non-null value with a missing source span as a hallucination', () => {
    const raw = JSON.stringify({
      attributes: [
        {
          key: 'waterproof_mm',
          value: 20000,
          confidence: 0.9,
          source_span: null,
        },
      ],
    });
    const result = parseExtractionResponse(raw, outerwearSchema, source);
    expect(result.attributes).toHaveLength(0);
    expect(result.drops[0]).toMatchObject({
      key: 'waterproof_mm',
      reason: 'value-without-source-span',
    });
  });

  it('accepts a source span whose text is in source even if reported offsets are wrong', () => {
    // The model quoted the right text but got the offsets wrong. This
    // is the common LLM failure mode (models quote well, count poorly).
    // The verifier ignores reported offsets and computes them
    // server-side from source.indexOf(text).
    const raw = JSON.stringify({
      attributes: [
        {
          key: 'waterproof_mm',
          value: 20000,
          confidence: 0.9,
          source_span: { text: '20000mm', start: 0, end: 7 }, // wrong offsets
        },
      ],
    });
    const result = parseExtractionResponse(raw, outerwearSchema, source);
    expect(result.drops).toHaveLength(0);
    const [attr] = result.attributes;
    expect(attr).toBeDefined();
    expect(attr?.value).toBe(20000);
    // Offsets were recomputed from indexOf, not taken from the model.
    const expectedStart = source.indexOf('20000mm');
    expect(attr?.sourceSpan).toEqual({
      text: '20000mm',
      start: expectedStart,
      end: expectedStart + '20000mm'.length,
    });
  });

  it('drops a source span whose text is not present in the source', () => {
    // The model returned a value with a quote that isn't actually in the
    // source text. This is the real hallucination case the substring
    // check catches — the model invented a quote.
    const raw = JSON.stringify({
      attributes: [
        {
          key: 'waterproof_mm',
          value: 15000,
          confidence: 0.9,
          source_span: { text: '15000mm', start: 0, end: 7 },
        },
      ],
    });
    const result = parseExtractionResponse(raw, outerwearSchema, source);
    expect(result.attributes).toHaveLength(0);
    expect(result.drops[0]).toMatchObject({
      key: 'waterproof_mm',
      reason: 'source-span-mismatch',
    });
  });

  it('drops an attribute whose key is not in the schema', () => {
    const raw = JSON.stringify({
      attributes: [{ key: 'invented_field', value: 'foo', confidence: 0.9, source_span: null }],
    });
    const result = parseExtractionResponse(raw, outerwearSchema, source);
    expect(result.attributes).toHaveLength(0);
    expect(result.drops[0]).toMatchObject({
      key: 'invented_field',
      reason: 'key-not-in-schema',
    });
  });

  it('drops attributes whose value type does not match the schema', () => {
    const raw = JSON.stringify({
      attributes: [
        {
          key: 'waterproof_mm',
          value: '20000mm',
          confidence: 0.9,
          source_span: findSpan(source, '20000mm'),
        },
      ],
    });
    const result = parseExtractionResponse(raw, outerwearSchema, source);
    // Value was string, schema expects number — coerced to null, then treated
    // as unsupported fact (not a hallucination) because value is null.
    expect(result.attributes[0]).toMatchObject({ key: 'waterproof_mm', value: null });
  });

  it('reports invalid-shape when the raw JSON is not parseable', () => {
    const result = parseExtractionResponse('not json', outerwearSchema, source);
    expect(result.attributes).toHaveLength(0);
    expect(result.drops[0]).toMatchObject({ reason: 'invalid-shape' });
  });

  it('reports invalid-shape when attributes is not an array', () => {
    const raw = JSON.stringify({ attributes: 'oops' });
    const result = parseExtractionResponse(raw, outerwearSchema, source);
    expect(result.attributes).toHaveLength(0);
    expect(result.drops[0]).toMatchObject({ reason: 'invalid-shape' });
  });

  it('clamps out-of-range confidence to zero', () => {
    const raw = JSON.stringify({
      attributes: [
        {
          key: 'waterproof_mm',
          value: 20000,
          confidence: 5,
          source_span: findSpan(source, '20000mm'),
        },
      ],
    });
    const result = parseExtractionResponse(raw, outerwearSchema, source);
    expect(result.attributes[0]?.confidence).toBe(0);
  });
});
