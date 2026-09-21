import { describe, expect, it } from 'vitest';

import type { RetrievedChunk } from '@groundwork/core';

import { rrf, weightedFusion } from './fusion.js';

function makeChunk(id: string, score: number): RetrievedChunk {
  return { chunkId: id, documentId: `doc-${id}`, text: `text ${id}`, score };
}

describe('rrf', () => {
  it('names itself with the k parameter', () => {
    expect(rrf(60).name).toBe('rrf(k=60)');
    expect(rrf(30).name).toBe('rrf(k=30)');
  });

  it('gives a chunk in both lists a higher score than either alone', () => {
    const dense = [makeChunk('a', 0.9), makeChunk('b', 0.8), makeChunk('c', 0.7)];
    const sparse = [makeChunk('b', 0.5), makeChunk('a', 0.4), makeChunk('d', 0.3)];
    const fused = rrf(60).fuse({ dense, sparse });
    const scoreOf = (id: string) => fused.find((c) => c.chunkId === id)?.score;
    // 'a' is rank 1 dense (1/61) + rank 2 sparse (1/62) ≈ 0.0325.
    // 'c' is rank 3 dense only (1/63) ≈ 0.0159.
    expect(scoreOf('a')).toBeGreaterThan(scoreOf('c') ?? 0);
    // 'b' is in both lists too, so should exceed 'c' and 'd'.
    expect(scoreOf('b')).toBeGreaterThan(scoreOf('c') ?? 0);
    expect(scoreOf('b')).toBeGreaterThan(scoreOf('d') ?? 0);
  });

  it('handles disjoint lists (no overlap)', () => {
    const dense = [makeChunk('a', 0.9)];
    const sparse = [makeChunk('b', 0.5)];
    const fused = rrf(60).fuse({ dense, sparse });
    expect(fused).toHaveLength(2);
    expect(fused.map((c) => c.chunkId).sort()).toEqual(['a', 'b']);
  });

  it('handles empty inputs', () => {
    expect(rrf().fuse({ dense: [], sparse: [] })).toEqual([]);
    const dense = [makeChunk('a', 0.9)];
    expect(rrf().fuse({ dense, sparse: [] })).toHaveLength(1);
  });

  it('sorts by descending fused score', () => {
    const dense = [makeChunk('a', 0.9), makeChunk('b', 0.8), makeChunk('c', 0.7)];
    const sparse: RetrievedChunk[] = [];
    const fused = rrf(60).fuse({ dense, sparse });
    expect(fused.map((c) => c.chunkId)).toEqual(['a', 'b', 'c']);
  });

  it('preserves metadata when a chunk appears in both lists (regression: sparse-overwrites-dense)', () => {
    // The bug: PgvectorDenseRetriever hydrates metadata; PgTsRankRetriever
    // does not. On collision, sparse iteration overwrote the dense
    // version of the chunk object, dropping metadata. Downstream —
    // stock_lookup's matchedHandle/matchedTitle → product_links —
    // silently returned null on every good match.
    const denseChunk: RetrievedChunk = {
      chunkId: 'a',
      documentId: 'doc-a',
      text: 'text a',
      score: 0.9,
      metadata: { handle: 'baileys-no-4-top-line-cubes', type: 'Feed' },
    };
    const sparseChunk: RetrievedChunk = {
      chunkId: 'a',
      documentId: 'doc-a',
      text: 'text a',
      score: 0.5,
      // no metadata — mirrors what PgTsRankRetriever emits today
    };
    const fused = rrf(60).fuse({ dense: [denseChunk], sparse: [sparseChunk] });
    expect(fused).toHaveLength(1);
    expect(fused[0]?.metadata).toEqual({
      handle: 'baileys-no-4-top-line-cubes',
      type: 'Feed',
    });
  });

  it('takes metadata from sparse when only sparse has it (defensive symmetry)', () => {
    const denseChunk: RetrievedChunk = {
      chunkId: 'a',
      documentId: 'doc-a',
      text: 'text a',
      score: 0.9,
      // no metadata (hypothetical future — dense not hydrated)
    };
    const sparseChunk: RetrievedChunk = {
      chunkId: 'a',
      documentId: 'doc-a',
      text: 'text a',
      score: 0.5,
      metadata: { handle: 'x' },
    };
    const fused = rrf(60).fuse({ dense: [denseChunk], sparse: [sparseChunk] });
    expect(fused[0]?.metadata).toEqual({ handle: 'x' });
  });
});

describe('weightedFusion', () => {
  it('names itself with the weights', () => {
    expect(weightedFusion(0.5, 0.5).name).toBe('weighted(dense=0.5,sparse=0.5)');
    expect(weightedFusion(0.7, 0.3).name).toBe('weighted(dense=0.7,sparse=0.3)');
  });

  it('normalises each list to [0,1] before combining', () => {
    const dense = [makeChunk('a', 10), makeChunk('b', 5)]; // dense scores 10, 5
    const sparse = [makeChunk('a', 0.4), makeChunk('b', 0.2)]; // sparse scores 0.4, 0.2
    const fused = weightedFusion(0.5, 0.5).fuse({ dense, sparse });
    // Normalised: a=(1.0, 1.0), b=(0.0, 0.0). Fused: a=1.0, b=0.0.
    const scoreOf = (id: string) => fused.find((c) => c.chunkId === id)?.score;
    expect(scoreOf('a')).toBeCloseTo(1);
    expect(scoreOf('b')).toBeCloseTo(0);
  });

  it('treats identical scores as maximum confidence', () => {
    // Range=0 edge case.
    const dense = [makeChunk('a', 5), makeChunk('b', 5)];
    const sparse: RetrievedChunk[] = [];
    const fused = weightedFusion(1.0, 0.0).fuse({ dense, sparse });
    // Both normalise to 1; only 'a' has sparse=0.
    const scoreOf = (id: string) => fused.find((c) => c.chunkId === id)?.score;
    expect(scoreOf('a')).toBeCloseTo(1);
    expect(scoreOf('b')).toBeCloseTo(1);
  });

  it('handles empty inputs', () => {
    expect(weightedFusion().fuse({ dense: [], sparse: [] })).toEqual([]);
  });

  it('combines a chunk that appears only in dense with only its dense component', () => {
    const dense = [makeChunk('a', 10)];
    const sparse: RetrievedChunk[] = [];
    const fused = weightedFusion(0.6, 0.4).fuse({ dense, sparse });
    const scoreOf = (id: string) => fused.find((c) => c.chunkId === id)?.score;
    // 'a' is normalised dense score = 1, contribution 0.6 * 1 = 0.6. No sparse.
    expect(scoreOf('a')).toBeCloseTo(0.6);
  });
});
