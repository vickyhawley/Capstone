/**
 * Deterministic chunk ID computation. ADR-0013.
 *
 * Chunks are identified by a UUID-shaped hash of
 * `(document_id, ordinal, sha256(text))`. Same input → same UUID,
 * across any number of ingests. Content change → new UUID.
 *
 * This closes the "stale UUID after re-ingest" failure family that
 * produced 0.0% recall across every retrieval config in the Sprint 2
 * sparse-fix rematch (see `docs/ai-assisted-development.md`).
 *
 * The output is a syntactically valid UUID (8-4-4-4-12 format) but
 * NOT a spec-compliant v5 UUID — v5 mandates a namespace UUID and a
 * specific hashing scheme. Syntactic validity is enough: Postgres
 * `uuid` type doesn't care about version bits, and every consumer
 * treats these as opaque IDs. Recorded here so a future reader
 * looking at a chunk ID isn't confused about which UUID version
 * generated it.
 */
import { createHash } from 'node:crypto';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Format the first 32 hex chars of a hash string as a UUID
 * (8-4-4-4-12). Caller is responsible for supplying enough hex.
 */
function toUuid(hex32: string): string {
  return (
    `${hex32.slice(0, 8)}-` +
    `${hex32.slice(8, 12)}-` +
    `${hex32.slice(12, 16)}-` +
    `${hex32.slice(16, 20)}-` +
    `${hex32.slice(20, 32)}`
  );
}

/**
 * Compute the deterministic chunk id.
 *
 * `document_id` is the parent document's UUID (already deterministic
 * for a given source+source_ref pair, because documents use their own
 * unique constraint). `ordinal` is the 0-based position within the
 * document — the existing `chunks_document_ordinal_unique` constraint
 * from migration 001. `text` is the chunk's rendered content — the
 * same string that gets `to_tsvector('english', text)` into
 * `content_tsv` and embedded.
 *
 * The three inputs together fully determine what a chunk semantically
 * *is*. Change any one and the chunk is different; ID should differ
 * too. This is precisely the content-change detection property the
 * ADR names.
 */
export function computeChunkId(documentId: string, ordinal: number, text: string): string {
  const contentHash = sha256Hex(text);
  const input = `${documentId}:${ordinal}:${contentHash}`;
  const hex = sha256Hex(input); // 64 hex chars
  return toUuid(hex.slice(0, 32));
}
