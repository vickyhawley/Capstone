/**
 * Retriever port.
 *
 * Fetches a bounded set of candidate chunks for a query from the
 * knowledge base. Implementations may be dense, sparse, or hybrid (see
 * docs/adr/0001-hybrid-retrieval.md).
 *
 * Assumes:
 * - The knowledge base has been indexed out of band; this port reads only.
 * - `topK` is an upper bound. Implementations may return fewer results.
 * - Scores are opaque to core — comparable within a single call, not
 *   across implementations or across time.
 */
export interface RetrievalQuery {
  readonly text: string;
  readonly topK: number;
  readonly filters?: Readonly<Record<string, string | number | boolean>>;
}

export interface RetrievedChunk {
  readonly chunkId: string;
  readonly documentId: string;
  readonly text: string;
  readonly score: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Retriever {
  retrieve(query: RetrievalQuery): Promise<readonly RetrievedChunk[]>;
}
