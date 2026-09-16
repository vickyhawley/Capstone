/**
 * Unit tests for computeChunkId. ADR-0013.
 *
 * The properties this function must satisfy are all mechanically
 * testable:
 *
 * 1. Determinism — same inputs → same output, always.
 * 2. Content-change sensitivity — different text → different id.
 * 3. Ordinal sensitivity — different position → different id.
 * 4. Document sensitivity — different parent → different id.
 * 5. Output shape — valid UUID format (8-4-4-4-12 hex).
 *
 * Every property has a named test. These are what the migration
 * relies on; a regression in any of them would silently reintroduce
 * the stale-UUID failure class.
 */
import { describe, expect, it } from 'vitest';

import { computeChunkId } from './compute-chunk-id.js';

const docA = '00000000-0000-0000-0000-000000000001';
const docB = '00000000-0000-0000-0000-000000000002';

describe('computeChunkId — determinism', () => {
  it('returns the same UUID for identical inputs', () => {
    const a = computeChunkId(docA, 0, 'hello world');
    const b = computeChunkId(docA, 0, 'hello world');
    expect(a).toBe(b);
  });

  it('is stable across many calls in a hot loop', () => {
    const first = computeChunkId(docA, 5, 'some chunk text');
    for (let i = 0; i < 1000; i++) {
      expect(computeChunkId(docA, 5, 'some chunk text')).toBe(first);
    }
  });
});

describe('computeChunkId — content sensitivity', () => {
  it('differs when text changes', () => {
    const a = computeChunkId(docA, 0, 'hello world');
    const b = computeChunkId(docA, 0, 'hello world!');
    expect(a).not.toBe(b);
  });

  it('differs on whitespace-only change (no silent normalisation)', () => {
    // Silent normalisation is a bad idea — a chunker that starts
    // adding trailing newlines is a real content change, not a
    // formatting artefact to hide.
    const a = computeChunkId(docA, 0, 'text');
    const b = computeChunkId(docA, 0, 'text\n');
    expect(a).not.toBe(b);
  });

  it('differs on case change (no silent lowercase)', () => {
    const a = computeChunkId(docA, 0, 'Bedmax');
    const b = computeChunkId(docA, 0, 'bedmax');
    expect(a).not.toBe(b);
  });
});

describe('computeChunkId — ordinal sensitivity', () => {
  it('differs when ordinal changes (same text, different position)', () => {
    const a = computeChunkId(docA, 0, 'shared');
    const b = computeChunkId(docA, 1, 'shared');
    expect(a).not.toBe(b);
  });

  it('handles ordinal 0 and large ordinals identically', () => {
    // Just verifying the function doesn't have off-by-one weirdness
    // around 0 or int rollover territory.
    expect(computeChunkId(docA, 0, 't')).toMatch(/^[0-9a-f-]+$/);
    expect(computeChunkId(docA, 1_000_000, 't')).toMatch(/^[0-9a-f-]+$/);
  });
});

describe('computeChunkId — document sensitivity', () => {
  it('differs when document_id changes (same ordinal + text)', () => {
    const a = computeChunkId(docA, 0, 'shared');
    const b = computeChunkId(docB, 0, 'shared');
    expect(a).not.toBe(b);
  });
});

describe('computeChunkId — output shape', () => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('returns a syntactically valid UUID (8-4-4-4-12 lowercase hex)', () => {
    expect(computeChunkId(docA, 0, 'anything')).toMatch(uuidRegex);
  });

  it('every input shape produces a valid UUID', () => {
    const inputs: [string, number, string][] = [
      [docA, 0, ''],
      [docA, 0, 'a'],
      [docA, 999_999, 'a'.repeat(100_000)],
      [docB, 42, 'text with UTF-8: café ☕ 日本語'],
    ];
    for (const [d, o, t] of inputs) {
      expect(computeChunkId(d, o, t)).toMatch(uuidRegex);
    }
  });
});

/**
 * The realistic collision risks aren't SHA-256 collisions between
 * random inputs — SHA-256 has a birthday bound at ~2^128 that no
 * corpus at this scale approaches. The risks are that computeChunkId
 * silently drops one of its three inputs, so that inputs which
 * *should* produce distinct IDs collide because only two of three
 * dimensions actually contribute.
 *
 * Each collision-risk axis gets its own named test with corpus-
 * realistic inputs — long-ish paragraph text, real-UUID-shaped
 * document IDs, adjacent ordinals — so a regression that drops any
 * one of the three inputs from the hash gets caught by name.
 */
describe('computeChunkId — near-miss inputs must produce distinct IDs', () => {
  // Corpus-realistic chunk text: a paragraph like what
  // packages/ingestion/src/product-chunker.ts emits for a product
  // listing. Length matters — a 500-char chunk with one character
  // changed is the "typo fix in a product description" case.
  const baseText =
    '# Bedmax Shavings\n' +
    'Vendor: bedmax\n' +
    'Type: Bedding\n' +
    'Tags: barn & stable, bedding, lockable feed bins, shavings\n' +
    'Bedmax is the original large-flake shavings, dust-extracted, ' +
    'kiln-dried and produced to a consistent quality across every bale. ' +
    'Sold as 22kg bales; typical usage 1-2 bales per week for a ' +
    'standard 12x12 stable depending on horse habits and stripping ' +
    'schedule.';

  it('near-identical TEXT at same (doc, ordinal) → distinct IDs', () => {
    // "Chunk content was edited" case. Every variation is a
    // plausible one-character-off edit to product-listing prose.
    const variations = [
      baseText,
      `${baseText}.`, // trailing period added
      `${baseText}\n`, // trailing newline (chunker whitespace drift)
      baseText.replace('22kg', '22 kg'), // spacing normalisation
      baseText.replace('Bedmax is', 'Bedmax  is'), // double-space typo
      baseText.replace('kiln-dried', 'kiln dried'), // hyphen dropped
      baseText.replace('bedmax', 'BedMax'), // Vendor casing shift
      baseText.replace('1-2', '1 to 2'), // en-dash-ish rewording
      baseText.replace('consistent quality', 'consistant quality'), // typo introduced
      baseText.replace('12x12 stable', '12×12 stable'), // ASCII-x to ×
    ];
    const doc = '01234567-89ab-cdef-0123-456789abcdef';
    const ids = new Set(variations.map((t) => computeChunkId(doc, 0, t)));
    expect(ids.size).toBe(variations.length);
  });

  it('adjacent ORDINALS with identical text + doc → distinct IDs', () => {
    // "Same boilerplate chunk repeated across sections" case.
    // Rare in the current corpus but not impossible — some guides
    // repeat safety warnings across sections; if the chunker
    // preserves that, the two chunks are semantically the same but
    // structurally different (different ordinal). Their IDs must
    // differ, or a reader that stores chunk IDs can't distinguish
    // the two positions.
    const doc = '01234567-89ab-cdef-0123-456789abcdef';
    const ids = new Set(Array.from({ length: 100 }, (_, o) => computeChunkId(doc, o, baseText)));
    expect(ids.size).toBe(100);
  });

  it('near-miss DOC IDs with same (ordinal, text) → distinct IDs', () => {
    // "Same boilerplate chunk shared across products" — very
    // common in the NFCS corpus. Feed products often share
    // near-identical description prose (same vendor's template).
    // The chunker treats each product as its own document with its
    // own UUID; those UUIDs come from gen_random_uuid() with real
    // randomness. Simulating that with 100 doc IDs that vary
    // narrowly and widely — narrow variance stresses the low-order
    // hex, wide variance stresses the whole ID.
    // Narrow-miss: last 4 hex chars vary from 0000 to 0031, first 8
    // of the last segment are identical. Keeps the UUID shape
    // syntactically valid (12 hex chars in the last segment
    // always) — an earlier version of this test used
    // `padStart(1, '0')` which grew the segment past 12 for i>=16
    // and made the IDs different by length rather than by hex-char
    // near-miss shape.
    const narrowMiss = Array.from(
      { length: 50 },
      (_, i) => `01234567-89ab-cdef-0123-45678900${i.toString(16).padStart(4, '0')}`,
    );
    // Wide-miss: first segment varies with a stride that spreads
    // across the whole hex space, so no two docIds share a leading
    // prefix beyond the first two hex chars.
    const wideMiss = Array.from({ length: 50 }, (_, i) => {
      const first = (i * 0x02040810).toString(16).padStart(8, '0').slice(-8);
      const last = (i * 0x0123456789ab).toString(16).padStart(12, '0').slice(-12);
      return `${first}-89ab-cdef-0123-${last}`;
    });
    const docIds = [...narrowMiss, ...wideMiss];
    // Sanity: every generated docId must be UUID-shaped.
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const d of docIds) {
      expect(d, `generated docId not UUID-shaped: ${d}`).toMatch(uuidRegex);
    }
    const ids = new Set(docIds.map((d) => computeChunkId(d, 0, baseText)));
    expect(ids.size).toBe(docIds.length);
  });

  it('cross-product of all three axes → every combination distinct', () => {
    // Belt-and-braces: cross the three axes so a bug that drops
    // any *combination* of two inputs (e.g. hashes only text, or
    // only doc + ordinal) is caught too. 10 × 10 × 10 = 1000
    // corpus-realistic combinations; each combination is
    // pathologically similar to its neighbours.
    const docs = Array.from(
      { length: 10 },
      (_, d) => `01234567-89ab-cdef-0123-45678900000${d.toString(16)}`,
    );
    const textVariations = [
      baseText,
      `${baseText} `,
      `${baseText}.`,
      baseText.replace('22kg', '22 kg'),
      baseText.replace('Bedmax', 'bedmax'),
      baseText.replace('bale', 'bag'),
      baseText.replace('stable', 'stall'),
      baseText.replace('kiln-dried', 'kiln dried'),
      baseText.replace('shavings', 'shaving'),
      baseText.replace('1-2', '2-3'),
    ];
    const ids = new Set<string>();
    for (const d of docs) {
      for (let o = 0; o < 10; o++) {
        for (const t of textVariations) {
          ids.add(computeChunkId(d, o, t));
        }
      }
    }
    expect(ids.size).toBe(1000);
  });
});
