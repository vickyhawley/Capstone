import { describe, expect, it } from 'vitest';

import { feedSchema, outerwearSchema } from '@groundwork/core';

import { composeSource, composeSystemPrompt, composeUserPrompt } from './openai-extractor.js';

/**
 * The OpenAI call itself is not unit-tested — that's a live wire against
 * a paid API. This file locks the prompt-composition surface so a change
 * to the extractor prompt shows in review as a diff, matching the
 * pattern used by the chunker snapshot tests.
 */

describe('composeSource', () => {
  it('joins title, description, and variants into a single string', () => {
    const source = composeSource({
      title: 'Baileys No 8 With Turmeric',
      description: 'A high-fibre conditioning mix.',
      variants: ['20 kg', '25 kg'],
    });
    expect(source).toMatchInlineSnapshot(`
      "Baileys No 8 With Turmeric

      A high-fibre conditioning mix.

      Variants: 20 kg, 25 kg"
    `);
  });

  it('omits the variants line when there are no variants', () => {
    const source = composeSource({
      title: 'Bespoke Rug',
      description: 'One-off.',
      variants: [],
    });
    expect(source).not.toContain('Variants:');
  });
});

describe('composeSystemPrompt', () => {
  it('renders one line per attribute with type, enum values, unit, and guidance', () => {
    const prompt = composeSystemPrompt(feedSchema);
    expect(prompt).toContain('You extract product attributes for the Feed product type.');
    expect(prompt).toContain(
      '- feeding_rate_g_per_100kg_per_day (number) [g per 100 kg horse per day]',
    );
    expect(prompt).toContain('- species (enum) (one of: horse, dog, cat, poultry');
  });

  it('names the source-span rule prominently', () => {
    const prompt = composeSystemPrompt(outerwearSchema);
    expect(prompt).toMatch(/source_span MUST be a substring of the source text/);
    expect(prompt).toMatch(/otherwise the attribute will be dropped/i);
  });

  it('names the never-guess rule', () => {
    const prompt = composeSystemPrompt(outerwearSchema);
    expect(prompt).toMatch(/never guess/i);
  });
});

describe('composeUserPrompt', () => {
  it('names the source offsets as 0-indexed', () => {
    const prompt = composeUserPrompt('Anything.');
    expect(prompt).toContain('0-indexed');
    expect(prompt).toContain('Anything.');
  });
});
