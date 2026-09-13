/**
 * Reranker port.
 *
 * Reorders a set of already-retrieved candidates for a query. Whether a
 * real reranker earns its latency and cost is a Sprint 1 experiment — see
 * docs/adr/0001-hybrid-retrieval.md. Until then, `NoopReranker` returns
 * the input order unchanged.
 *
 * Assumes:
 * - Candidates are already retrieved. This port does not fetch.
 * - The returned array MUST contain a subset of the input by `id`.
 *   Implementations MAY drop but MUST NOT invent candidates.
 * - Scores are opaque and only comparable within a single call.
 */
export interface RerankableCandidate {
  readonly id: string;
  readonly text: string;
  readonly score: number;
}

export interface RerankedCandidate {
  readonly id: string;
  readonly score: number;
}

export interface Reranker {
  rerank(
    query: string,
    candidates: readonly RerankableCandidate[],
  ): Promise<readonly RerankedCandidate[]>;
}
