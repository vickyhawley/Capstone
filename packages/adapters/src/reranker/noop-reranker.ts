import type { RerankableCandidate, RerankedCandidate, Reranker } from '@groundwork/core';

/**
 * Pass-through reranker. Preserves input order and scores.
 *
 * This is the scaffold default and the control in the Sprint 1 rerank
 * experiment (see docs/adr/0001-hybrid-retrieval.md). Any real
 * implementation must be measured against this baseline before it lands.
 */
export class NoopReranker implements Reranker {
  async rerank(
    _query: string,
    candidates: readonly RerankableCandidate[],
  ): Promise<readonly RerankedCandidate[]> {
    return candidates.map(({ id, score }) => ({ id, score }));
  }
}
