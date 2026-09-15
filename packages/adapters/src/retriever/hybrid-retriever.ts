/**
 * Hybrid retriever — composes two child retrievers (typically dense
 * and sparse) with a fusion strategy.
 *
 * Both children are queried in parallel; the returned lists are handed
 * to the fusion strategy which produces a single ranked list. Each
 * child is asked for its own topK; the fused output is truncated to
 * the caller's requested topK.
 *
 * Filters (per ADR-0001 F2): both children are asked for 4× the topK
 * to over-fetch before any downstream filter is applied. The current
 * Retriever port doesn't carry filters into the RPCs (that's a Sprint 2
 * follow-up when ADR-0007 lands with the filter taxonomy), so the
 * over-fetch is defensive against the current baseline: even if only
 * one side hits, we still return a full topK from the union.
 */

import type { RetrievalQuery, RetrievedChunk, Retriever } from '@groundwork/core';

import type { FusionStrategy } from './fusion.js';

export interface HybridRetrieverOptions {
  readonly overFetchMultiplier?: number;
}

export class HybridRetriever implements Retriever {
  private readonly overFetchMultiplier: number;

  constructor(
    private readonly dense: Retriever,
    private readonly sparse: Retriever,
    private readonly fusion: FusionStrategy,
    options: HybridRetrieverOptions = {},
  ) {
    this.overFetchMultiplier = options.overFetchMultiplier ?? 4;
  }

  async retrieve(query: RetrievalQuery): Promise<readonly RetrievedChunk[]> {
    const overFetch = query.topK * this.overFetchMultiplier;
    const [dense, sparse] = await Promise.all([
      this.dense.retrieve({ ...query, topK: overFetch }),
      this.sparse.retrieve({ ...query, topK: overFetch }),
    ]);
    const fused = this.fusion.fuse({ dense, sparse });
    return fused.slice(0, query.topK);
  }
}
