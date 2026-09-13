import { describe, expect, it } from 'vitest';
import { NoopReranker } from './noop-reranker.js';

describe('NoopReranker', () => {
  it('returns candidates in input order', async () => {
    const reranker = new NoopReranker();
    const candidates = [
      { id: 'a', text: 'alpha', score: 0.5 },
      { id: 'b', text: 'beta', score: 0.9 },
      { id: 'c', text: 'gamma', score: 0.1 },
    ];
    const result = await reranker.rerank('irrelevant', candidates);
    expect(result.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(result.map((c) => c.score)).toEqual([0.5, 0.9, 0.1]);
  });

  it('handles empty input', async () => {
    const reranker = new NoopReranker();
    const result = await reranker.rerank('irrelevant', []);
    expect(result).toEqual([]);
  });
});
