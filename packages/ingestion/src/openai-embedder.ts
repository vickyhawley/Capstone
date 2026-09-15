/**
 * OpenAI embedding batch call for the ingest pipeline.
 *
 * Uses the ADR-0001 committed model and dimensionality
 * (`EMBEDDING_MODEL` / `EMBEDDING_DIM` in `@groundwork/core`). The
 * ingester and retriever must share these constants — a mismatch
 * silently produces zero recall without raising any error, which is
 * exactly the GW-01 embedding-gap failure mode. Importing from core
 * makes that impossible.
 *
 * OpenAI's embeddings endpoint accepts an array of strings and
 * returns embeddings in the same order. The API request cap is 2048
 * inputs per call; this function batches to `BATCH_SIZE` per call so
 * a large corpus refresh doesn't hit that ceiling.
 */

import { EMBEDDING_DIM, EMBEDDING_MODEL } from '@groundwork/core';
import type OpenAI from 'openai';

/**
 * How many chunk texts to send per OpenAI embeddings API call.
 * 50 keeps each request small enough to retry cheaply on transient
 * errors, and small enough that per-request latency stays bounded.
 */
export const EMBED_BATCH_SIZE = 50;

export async function embedTexts(openai: OpenAI, texts: readonly string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: [...batch],
    });
    if (response.data.length !== batch.length) {
      throw new Error(
        `embedding batch size mismatch: sent ${batch.length}, got ${response.data.length}`,
      );
    }
    for (const item of response.data) {
      if (item.embedding.length !== EMBEDDING_DIM) {
        throw new Error(
          `embedding dim mismatch: got ${item.embedding.length}, expected ${EMBEDDING_DIM}`,
        );
      }
      embeddings.push(item.embedding);
    }
  }
  return embeddings;
}
