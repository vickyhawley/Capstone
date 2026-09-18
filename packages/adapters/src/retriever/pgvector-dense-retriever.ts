/**
 * Dense retriever — pgvector cosine similarity over
 * `chunks.embedding`.
 *
 * The query is embedded with OpenAI's `text-embedding-3-small` at 1536
 * dimensions to match migration 001's `vector(1536)` column and
 * ADR-0001's embedding commitment. The embedding call is one round
 * trip per query; batching is a Sprint 2 candidate if p95 latency
 * becomes the bottleneck.
 *
 * Metadata hydration (2026-09-18): the `search_chunks_dense` RPC
 * returns (chunk_id, document_id, chunk_text, score) but not
 * `metadata`. Consumers reading `.metadata` (ProductStockLookupTool's
 * `matchedHandle`/`matchedTitle`; ProductSubstituteLookupTool's
 * anchor + primary-attribute lookup) need it, so this adapter does
 * one follow-up SELECT keyed by the returned chunk IDs. One extra
 * round-trip; sub-100ms. Alternative — extend the RPC to return
 * metadata — is a Postgres migration on the roadmap.
 */

import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  type RetrievalQuery,
  type RetrievedChunk,
  type Retriever,
} from '@groundwork/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type OpenAI from 'openai';

interface DenseRow {
  readonly chunk_id: string;
  readonly document_id: string;
  readonly chunk_text: string;
  readonly score: number;
}

interface ChunkMetadataRow {
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>> | null;
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
    if (rows.length === 0) return [];

    // Follow-up SELECT for metadata — the RPC returns chunk_text +
    // score but not metadata. See file header for the rationale.
    const chunkIds = rows.map((r) => r.chunk_id);
    const { data: metaData, error: metaError } = await this.supabase
      .from('chunks')
      .select('id, metadata')
      .in('id', chunkIds);
    if (metaError) {
      throw new Error(`dense retrieval metadata hydration failed: ${metaError.message}`);
    }
    const metaMap = new Map<string, Readonly<Record<string, unknown>>>();
    for (const m of (metaData ?? []) as ChunkMetadataRow[]) {
      if (m.metadata) metaMap.set(m.id, m.metadata);
    }

    return rows.map((row) => {
      const meta = metaMap.get(row.chunk_id);
      const base = {
        chunkId: row.chunk_id,
        documentId: row.document_id,
        text: row.chunk_text,
        score: row.score,
      };
      return meta ? { ...base, metadata: meta } : base;
    });
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
