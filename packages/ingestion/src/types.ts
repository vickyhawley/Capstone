/**
 * Shapes produced by the chunkers. These map onto the `documents` and
 * `chunks` tables in supabase/migrations/001; the persistence layer
 * (GW-01 commit b) is a thin translation from these types to inserts.
 *
 * Chunkers are pure: input in, DocumentWithChunks out, no side effects,
 * no DB, no LLM. Extraction is composed separately by the runner (see
 * ingest-runner in the persistence commit).
 */

export type ContentType = 'product' | 'guide';

export interface DocumentInput {
  readonly source: string;
  readonly sourceRef: string;
  readonly title: string;
  readonly url: string | null;
  readonly contentType: ContentType;
  readonly language: string;
  readonly contentHash: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ChunkInput {
  readonly ordinal: number;
  readonly parentOrdinal: number | null;
  readonly text: string;
  readonly tokenCount: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  /**
   * Optional pgvector row for the chunk. When present, persistence
   * writes it to `chunks.embedding`. When absent, `chunks.embedding`
   * stays NULL (which is what happened in GW-01 pre-fold-in and
   * silently broke dense retrieval — see the sprint 1 close-out
   * correction). ADR-0001 embedding-model commitment.
   */
  readonly embedding?: readonly number[];
}

export interface DocumentWithChunks {
  readonly document: DocumentInput;
  readonly chunks: readonly ChunkInput[];
}
