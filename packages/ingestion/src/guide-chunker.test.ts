import { describe, expect, it } from 'vitest';

import { OVERLAP_CHARS, TARGET_CHARS, chunkGuide } from './guide-chunker.js';

const shortGuide = `# How to size a rug

A quick reference for choosing rug size by horse height and body shape.

## Measuring your horse

Measure from the centre of the chest, along the shoulder, to the point of the tail.

## Common sizes

- 5'6" fits most native ponies (~13.2hh).
- 6'0" fits most cobs (~14.2hh).
- 6'6" fits most lightweight horses (~15.2hh).
`;

const oversizedSection = `# Guide

## Long section

${'The quick brown fox jumps over the lazy dog. '.repeat(50)}
`;

describe('chunkGuide', () => {
  it('throws on empty markdown', () => {
    expect(() => chunkGuide({ markdown: '   ', slug: 'x' })).toThrow(/empty markdown/);
  });

  it('splits on H2 boundaries and captures heading path', () => {
    const result = chunkGuide({ markdown: shortGuide, slug: 'rug-sizing' });
    // Expect three chunks: preamble (H1 + intro), Measuring, Common sizes.
    expect(result.chunks).toHaveLength(3);
    expect(result.chunks[0]?.metadata['heading_path']).toEqual(['How to size a rug']);
    expect(result.chunks[1]?.metadata['heading_path']).toEqual([
      'How to size a rug',
      'Measuring your horse',
    ]);
    expect(result.chunks[2]?.metadata['heading_path']).toEqual([
      'How to size a rug',
      'Common sizes',
    ]);
  });

  it('carries the guide slug in every chunk metadata', () => {
    const result = chunkGuide({ markdown: shortGuide, slug: 'rug-sizing' });
    for (const chunk of result.chunks) {
      expect(chunk.metadata['guide_slug']).toBe('rug-sizing');
    }
  });

  it('extracts the H1 as the document title when title is not supplied', () => {
    const result = chunkGuide({ markdown: shortGuide, slug: 'rug-sizing' });
    expect(result.document.title).toBe('How to size a rug');
    expect(result.document.contentType).toBe('guide');
    expect(result.document.sourceRef).toBe('rug-sizing.md');
  });

  it('prefers an explicit title over the H1', () => {
    const result = chunkGuide({
      markdown: shortGuide,
      slug: 'rug-sizing',
      title: 'Sizing rugs (custom)',
    });
    expect(result.document.title).toBe('Sizing rugs (custom)');
  });

  it('splits an oversized section into overlapping windows', () => {
    const result = chunkGuide({ markdown: oversizedSection, slug: 'g' });
    // The Long section text is >>800 chars so it should split.
    const longSectionChunks = result.chunks.filter(
      (c) => (c.metadata['heading_path'] as string[]).at(-1) === 'Long section',
    );
    expect(longSectionChunks.length).toBeGreaterThan(1);
    for (const chunk of longSectionChunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(TARGET_CHARS + 50);
    }
  });

  it('overlap between successive windows in the same section is non-empty', () => {
    const result = chunkGuide({ markdown: oversizedSection, slug: 'g' });
    const longSection = result.chunks.filter(
      (c) => (c.metadata['heading_path'] as string[]).at(-1) === 'Long section',
    );
    if (longSection.length >= 2) {
      const first = longSection[0]?.text ?? '';
      const second = longSection[1]?.text ?? '';
      // Some tail of `first` should appear at the head of `second` given
      // OVERLAP_CHARS. We assert the overlap length rather than exact bytes.
      const tailOfFirst = first.slice(-OVERLAP_CHARS);
      const headOfSecond = second.slice(0, OVERLAP_CHARS);
      // At least one shared word between tail-of-first and head-of-second.
      const firstWords = new Set(tailOfFirst.split(/\s+/).filter((w) => w.length > 3));
      const anyShared = headOfSecond.split(/\s+/).some((w) => w.length > 3 && firstWords.has(w));
      expect(anyShared).toBe(true);
    }
  });

  it('produces stable content hashes', () => {
    const a = chunkGuide({ markdown: shortGuide, slug: 'rug-sizing' });
    const b = chunkGuide({ markdown: shortGuide, slug: 'rug-sizing' });
    expect(a.document.contentHash).toBe(b.document.contentHash);
    expect(a.document.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('preamble section snapshot', () => {
    const result = chunkGuide({ markdown: shortGuide, slug: 'rug-sizing' });
    expect(result.chunks[0]?.text).toMatchInlineSnapshot(`
      "# How to size a rug

      A quick reference for choosing rug size by horse height and body shape."
    `);
  });
});
