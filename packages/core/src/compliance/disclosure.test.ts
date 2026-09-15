/**
 * Unit tests for the Article 50 disclosure text. ADR-0012.
 *
 * Content-constraint tests mirror the requirements in ADR-0012
 * §Artefact shape → Disclosure. A regression fails here before an
 * audit — that's the whole point of putting a test on prose.
 *
 * The specific required-phrase set is deliberately narrow: three or
 * four load-bearing tokens, not the whole sentence. A tight list
 * lets the disclosure be rephrased for tone without breaking every
 * time.
 */
import { describe, expect, it } from 'vitest';

import { ARTICLE_50_DISCLOSURE } from './disclosure.js';

function contains(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase());
}

describe('Article 50 disclosure — required content', () => {
  it('is non-empty', () => {
    expect(ARTICLE_50_DISCLOSURE.trim().length).toBeGreaterThan(0);
  });

  it('states this is an AI assistant', () => {
    expect(contains(ARTICLE_50_DISCLOSURE, 'AI assistant')).toBe(true);
  });

  it('distinguishes from shop staff', () => {
    // Any of these phrasings satisfies "user is not talking to a person"
    const staffPhrasings = ['not a member', 'not shop staff', 'not a person'];
    const hit = staffPhrasings.some((p) => contains(ARTICLE_50_DISCLOSURE, p));
    expect(hit).toBe(true);
  });

  it('routes clinical questions away from itself', () => {
    // "vet" must appear — the disclosure has to say that clinical
    // questions go to a vet, not to the assistant.
    expect(contains(ARTICLE_50_DISCLOSURE, 'vet')).toBe(true);
  });

  it('routes order/staff questions to the shop', () => {
    // The disclosure must set expectations that a real person is
    // available for staff-shaped questions.
    expect(contains(ARTICLE_50_DISCLOSURE, 'shop')).toBe(true);
  });

  it('tells the user how to reach a person', () => {
    const reachPhrasings = ['call', 'drop in', 'visit'];
    const hit = reachPhrasings.some((p) => contains(ARTICLE_50_DISCLOSURE, p));
    expect(hit).toBe(true);
  });
});

describe('Article 50 disclosure — phrasing rule (ADR-0012 Decision 5)', () => {
  it('does not use the word "bot"', () => {
    // Standalone "bot" reads as dismissive — ADR-0012 prescribes
    // "AI assistant". This test catches accidental substitution.
    expect(/\bbot\b/i.test(ARTICLE_50_DISCLOSURE)).toBe(false);
  });

  it('does not use unqualified "our assistant"', () => {
    // Ambiguous with a staff member. The disclosure must be explicit
    // about non-humanness.
    expect(/\bour assistant\b/i.test(ARTICLE_50_DISCLOSURE)).toBe(false);
  });
});

describe('Article 50 disclosure — length', () => {
  it('is short enough to read in under 10 seconds', () => {
    // Rough proxy: <= 600 characters. Longer disclosures are
    // ignored per ADR-0012's length target.
    expect(ARTICLE_50_DISCLOSURE.length).toBeLessThanOrEqual(600);
  });

  it('is at least a sentence long', () => {
    expect(ARTICLE_50_DISCLOSURE.length).toBeGreaterThan(80);
  });
});
