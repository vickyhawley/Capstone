/**
 * Dense retriever — pgvector cosine similarity over
 * `chunks.embedding`.
 *
 * The query is embedded with OpenAI's `text-embedding-3-small` at 1536
 * dimensions to match migration 001's `vector(1536)` column and
 * ADR-0001's embedding commitment. The embedding call is one round
 * trip per query; batching is a Sprint 2 candidate if p95 latency
 * becomes the bottleneck.
 */

import type { RetrievalQuery, RetrievedChunk, Retriever } from '@groundwork/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type OpenAI from 'openai';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;

interface DenseRow {
  readonly chunk_id: string;
  readonly document_id: string;
  readonly chunk_text: string;
  readonly score: number;
}

export class PgvectorDenseRetriever implements Retriever {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly openai: OpenAI,
  ) {}

  async retrieve(query: RetrievalQuery): Promise<readonly RetrievedChunk[]> {
    const embedding = await this.embed(query.text);
    const { data, error } = await this.supabase.rpc('search_chunks_dense', {
      query_embedding: embedding,
      match_count: query.topK,
    });
    if (error) {
      throw new Error(`dense retrieval failed: ${error.message}`);
    }
    const rows = (data ?? []) as DenseRow[];
    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      text: row.chunk_text,
      score: row.score,
    }));
  }

  private async embed(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
    });
    const first = response.data[0];
    if (!first) {
      throw new Error('embeddings response returned no vectors');
    }
    if (first.embedding.length !== EMBEDDING_DIM) {
      throw new Error(
        `embedding dimension mismatch: got ${first.embedding.length}, expected ${EMBEDDING_DIM}`,
      );
    }
    return first.embedding;
  }
}
