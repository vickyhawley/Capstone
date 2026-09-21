/**
 * Score fusion for hybrid retrieval.
 *
 * ADR-0001 named two candidate fusion strategies:
 *
 * 1. Reciprocal Rank Fusion (RRF) with the standard k=60 smoothing.
 *    Rank-only; no score normalisation.
 * 2. Weighted score normalisation. Min-max to [0,1] per source, then
 *    weighted combination.
 *
 * The Sprint 1 baseline compares both. Neither is inherently better —
 * RRF handles score-scale mismatches for free, weighted preserves the
 * confidence signal in the scores. The experiment measures which wins
 * on the golden set.
 */

import type { RetrievedChunk } from '@groundwork/core';

export interface FusionInput {
  readonly dense: readonly RetrievedChunk[];
  readonly sparse: readonly RetrievedChunk[];
}

export interface FusionStrategy {
  readonly name: string;
  fuse(input: FusionInput): readonly RetrievedChunk[];
}

/**
 * Reciprocal Rank Fusion. For each chunk that appears in either
 * ranked list, score = sum over the two lists of 1 / (k + rank).
 * Rank is 1-based; the smoothing constant `k` defaults to 60 per
 * Cormack et al. (2009), which ADR-0001 named as the standard.
 */
export function rrf(k = 60): FusionStrategy {
  return {
    name: `rrf(k=${k})`,
    fuse({ dense, sparse }) {
      const scores = new Map<string, { score: number; chunk: RetrievedChunk }>();
      for (const [index, chunk] of dense.entries()) {
        const rank = index + 1;
        const bump = 1 / (k + rank);
        const existing = scores.get(chunk.chunkId);
        if (existing) {
          scores.set(chunk.chunkId, {
            score: existing.score + bump,
            chunk: pickRicher(existing.chunk, chunk),
          });
        } else {
          scores.set(chunk.chunkId, { score: bump, chunk });
        }
      }
      for (const [index, chunk] of sparse.entries()) {
        const rank = index + 1;
        const bump = 1 / (k + rank);
        const existing = scores.get(chunk.chunkId);
        if (existing) {
          // On collision the two child retrievers return the same
          // chunk_id but potentially different shapes — dense
          // hydrates metadata via a follow-up SELECT (GW-19 fix),
          // sparse doesn't. `pickRicher` prefers the version that
          // carries metadata so downstream consumers (stock_lookup's
          // matchedHandle / matchedTitle, product_links) don't get
          // dropped on the common both-lists-hit case.
          scores.set(chunk.chunkId, {
            score: existing.score + bump,
            chunk: pickRicher(existing.chunk, chunk),
          });
        } else {
          scores.set(chunk.chunkId, { score: bump, chunk });
        }
      }
      return [...scores.values()]
        .sort((a, b) => b.score - a.score)
        .map(({ score, chunk }) => ({ ...chunk, score }));
    },
  };
}

/**
 * When the same chunk_id appears in both retrievers' outputs, one
 * version may carry metadata (dense post-GW-19) and the other may
 * not (sparse). Prefer the one that has it; if both do or neither
 * do, keep the incumbent to preserve the caller's iteration order
 * intent. Exported for testability + shared by both fusion
 * strategies below.
 */
export function pickRicher(a: RetrievedChunk, b: RetrievedChunk): RetrievedChunk {
  const aHas = a.metadata !== undefined && a.metadata !== null;
  const bHas = b.metadata !== undefined && b.metadata !== null;
  if (aHas && !bHas) return a;
  if (bHas && !aHas) return b;
  return a;
}

/**
 * Weighted score normalisation. Each ranked list's scores are
 * min-max normalised to [0, 1] independently; a chunk's fused score
 * is `denseWeight * denseNorm + sparseWeight * sparseNorm` (0 if the
 * chunk didn't appear in that list). Default 0.5 / 0.5 is
 * intentionally uncommitted — the Sprint 1 experiment or a Sprint 2
 * tuning pass may find a different balance.
 *
 * Edge case: if a list has a single element or all scores identical,
 * the min-max range is zero and every element normalises to 1. That's
 * a legitimate result (the retriever is confident all are equally
 * good), not a divide-by-zero to hide.
 */
export function weightedFusion(denseWeight = 0.5, sparseWeight = 0.5): FusionStrategy {
  return {
    name: `weighted(dense=${denseWeight},sparse=${sparseWeight})`,
    fuse({ dense, sparse }) {
      const denseNorm = normalise(dense);
      const sparseNorm = normalise(sparse);
      const merged = new Map<string, { score: number; chunk: RetrievedChunk }>();

      for (const chunk of dense) {
        merged.set(chunk.chunkId, {
          score: denseWeight * (denseNorm.get(chunk.chunkId) ?? 0),
          chunk,
        });
      }
      for (const chunk of sparse) {
        const existing = merged.get(chunk.chunkId);
        const sparseContribution = sparseWeight * (sparseNorm.get(chunk.chunkId) ?? 0);
        if (existing) {
          merged.set(chunk.chunkId, {
            score: existing.score + sparseContribution,
            chunk: existing.chunk,
          });
        } else {
          merged.set(chunk.chunkId, { score: sparseContribution, chunk });
        }
      }

      return [...merged.values()]
        .sort((a, b) => b.score - a.score)
        .map(({ score, chunk }) => ({ ...chunk, score }));
    },
  };
}

function normalise(chunks: readonly RetrievedChunk[]): Map<string, number> {
  if (chunks.length === 0) {
    return new Map();
  }
  const scores = chunks.map((c) => c.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;
  const result = new Map<string, number>();
  for (const chunk of chunks) {
    if (range === 0) {
      result.set(chunk.chunkId, 1);
    } else {
      result.set(chunk.chunkId, (chunk.score - min) / range);
    }
  }
  return result;
}
