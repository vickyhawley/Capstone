/**
 * Embedding model commitment (ADR-0001).
 *
 * Shared constants for the embedding model and dimensionality. Kept
 * in core so that the ingester (which writes to `chunks.embedding`)
 * and the retriever (which reads from it) cannot silently disagree.
 * If they used a different model for write and read, every recall
 * number would be zero without any error being raised — see the
 * GW-01 embedding-gap post-mortem in
 * `docs/ai-assisted-development.md` for what that looks like in
 * practice.
 *
 * Changing these values is a re-embed event: existing vectors in
 * `chunks.embedding` become invalid because they were produced by a
 * different model. See ADR-0001 §"Migration cost of changing
 * embedder later" for the full sequence.
 */

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;
