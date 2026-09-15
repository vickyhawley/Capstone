/**
 * OpenAI-backed attribute extraction. Composes a JSON-schema-constrained
 * prompt from an AttributeSchema, calls gpt-4o-mini with structured
 * outputs, and feeds the response to `parseExtractionResponse` for the
 * source-span-grounding invariants named in ADR-0004.
 *
 * gpt-4o-mini is committed by ADR-0004 (native structured-output support,
 * ~$0.0002 per product). If a later ADR moves off this model, the JSON
 * schema is portable — any Chat Completions API with structured outputs
 * mode accepts it.
 */

import type { AttributeSchema } from '@groundwork/core';
import type OpenAI from 'openai';

import { type ExtractionResult, parseExtractionResponse } from './attribute-extractor.js';

export const EXTRACTION_MODEL = 'gpt-4o-mini';
export const PROMPT_VERSION = '2026-09-15.1';

export interface ExtractionInput {
  readonly title: string;
  readonly description: string;
  readonly variants: readonly string[];
}

/**
 * Compose the concatenated source text against which extracted
 * source-spans are validated. The spans in the LLM response must be
 * offsets into *this* string. Kept as a separate exported function so
 * callers (and tests) can build the same source deterministically.
 */
export function composeSource(input: ExtractionInput): string {
  const parts = [input.title, '', input.description];
  if (input.variants.length > 0) {
    parts.push('', `Variants: ${input.variants.join(', ')}`);
  }
  return parts.join('\n').trim();
}

/**
 * Build a JSON-schema object suitable for OpenAI's structured-outputs
 * `response_format` from an AttributeSchema. The response is an array
 * of {key, value, confidence, source_span} objects.
 */
function toResponseJsonSchema(schema: AttributeSchema): Record<string, unknown> {
  const attributeItem: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['key', 'value', 'confidence', 'source_span'],
    properties: {
      key: {
        type: 'string',
        enum: schema.attributes.map((a) => a.key),
      },
      value: {
        // A union: string, number, boolean, or null. The parser coerces
        // to the schema-declared type at the ingest boundary; here we
        // accept any of the primitive JSON types.
        type: ['string', 'number', 'boolean', 'null'],
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
      },
      source_span: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'start', 'end'],
            properties: {
              text: { type: 'string' },
              start: { type: 'integer', minimum: 0 },
              end: { type: 'integer', minimum: 0 },
            },
          },
          { type: 'null' },
        ],
      },
    },
  };

  return {
    type: 'object',
    additionalProperties: false,
    required: ['attributes'],
    properties: {
      attributes: {
        type: 'array',
        items: attributeItem,
      },
    },
  };
}

function attributeDefinitionLine(attr: AttributeSchema['attributes'][number]): string {
  const enumClause = attr.enumValues ? ` (one of: ${attr.enumValues.join(', ')})` : '';
  const unitClause = attr.unit ? ` [${attr.unit}]` : '';
  return `- ${attr.key} (${attr.type})${enumClause}${unitClause}: ${attr.promptGuidance}`;
}

export function composeSystemPrompt(schema: AttributeSchema): string {
  return [
    `You extract product attributes for the ${schema.productType} product type.`,
    '',
    'Rules:',
    '- Return exactly one JSON object with the shape declared in the response format.',
    '- For each attribute in the schema, return one entry.',
    '- If the source text does not state a value, set value to null and source_span to null.',
    '- If value is not null, source_span MUST be a substring of the source text at the given [start, end) offsets. The substring MUST match text exactly. Otherwise the attribute will be dropped.',
    '- Never guess. Do not infer values from product-category knowledge or common defaults.',
    '- Confidence is your own honest estimate 0..1 of the extraction correctness.',
    '',
    'Schema:',
    ...schema.attributes.map(attributeDefinitionLine),
  ].join('\n');
}

export function composeUserPrompt(source: string): string {
  return `Source text (offsets used for source_span are 0-indexed into this string):\n\n${source}`;
}

export async function extractAttributes(
  openai: OpenAI,
  input: ExtractionInput,
  schema: AttributeSchema,
): Promise<ExtractionResult> {
  const source = composeSource(input);
  const responseSchema = toResponseJsonSchema(schema);

  const completion = await openai.chat.completions.create({
    model: EXTRACTION_MODEL,
    messages: [
      { role: 'system', content: composeSystemPrompt(schema) },
      { role: 'user', content: composeUserPrompt(source) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'attribute_extraction',
        strict: true,
        schema: responseSchema,
      },
    },
    temperature: 0,
  });

  const rawJson = completion.choices[0]?.message?.content ?? '{}';
  return parseExtractionResponse(rawJson, schema, source);
}
