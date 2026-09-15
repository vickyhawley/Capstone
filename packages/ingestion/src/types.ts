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
}

export interface DocumentWithChunks {
  readonly document: DocumentInput;
  readonly chunks: readonly ChunkInput[];
}
