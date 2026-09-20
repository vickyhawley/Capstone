/**
 * Sparse retriever — Postgres full-text search over `chunks.content_tsv`
 * via `ts_rank`.
 *
 * This is ts_rank, NOT BM25 (see ADR-0001, sparse index note). If
 * Sprint 1's baseline shows ts_rank is the retrieval bottleneck, the
 * upgrade path is pg_search (ParadeDB); that's a Sprint 2+ ADR.
 *
 * Uses the search_chunks_sparse RPC from migration 002 to keep the
 * SQL in one place. The RPC returns already-ranked chunks so this
 * adapter is a thin wrapper that shapes the response to the port.
 */

import type {
  CircuitBreaker,
  RetrievalQuery,
  RetrievedChunk,
  Retriever,
} from '@groundwork/core';
import type { SupabaseClient } from '@supabase/supabase-js';

interface SparseRow {
  readonly chunk_id: string;
  readonly document_id: string;
  readonly chunk_text: string;
  readonly score: number;
}

export class PgTsRankRetriever implements Retriever {
  constructor(
    private readonly supabase: SupabaseClient,
    /** Optional supabase breaker. GW-23. See dense retriever for
     *  why RPC error responses are re-thrown inside the wrapped fn
     *  (so "server said no" counts toward opening). */
    private readonly supabaseBreaker?: CircuitBreaker,
  ) {}

  async retrieve(query: RetrievalQuery): Promise<readonly RetrievedChunk[]> {
    const rows = await this.runSupabase(async (): Promise<SparseRow[]> => {
      const { data, error } = await this.supabase.rpc('search_chunks_sparse', {
        query_text: query.text,
        match_count: query.topK,
      });
      if (error) throw new Error(`sparse retrieval failed: ${error.message}`);
      return (data ?? []) as SparseRow[];
    });
    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      text: row.chunk_text,
      score: row.score,
    }));
  }

  private async runSupabase<T>(fn: () => Promise<T>): Promise<T> {
    return this.supabaseBreaker ? this.supabaseBreaker.run(fn) : fn();
  }
}
