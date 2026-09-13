import {
  NotImplementedError,
  type RetrievalQuery,
  type RetrievedChunk,
  type Retriever,
} from '@groundwork/core';

export class StubRetriever implements Retriever {
  async retrieve(_query: RetrievalQuery): Promise<readonly RetrievedChunk[]> {
    throw new NotImplementedError('Retriever', 'Sprint 1', 'wire pgvector + BM25 hybrid');
  }
}
