/**
 * Persistence for chunker output. Takes a DocumentWithChunks and
 * writes it to Supabase's `documents` + `chunks` tables (migration
 * 001). Idempotent by (source, source_ref) unique constraint on
 * documents.
 *
 * The write is two-step (upsert document, replace chunks) because
 * chunk composition may change across re-ingests. supabase-js doesn't
 * expose a first-class transaction API, so a hard failure between
 * the delete and the insert would leave the document with zero
 * chunks briefly. A subsequent re-run heals that state. If atomicity
 * becomes load-bearing (e.g. concurrent readers of a partially-ingested
 * corpus), lift the operation to a Postgres function called via RPC.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { computeChunkId } from './compute-chunk-id.js';
import type { ChunkInput, DocumentInput, DocumentWithChunks } from './types.js';

export interface PersistResult {
  readonly documentId: string;
  readonly chunkIds: readonly string[];
  readonly action: 'inserted' | 'updated' | 'unchanged' | 'forced';
}

export interface PersistOptions {
  /**
   * Force chunk replacement even if the document's content_hash is
   * unchanged. Use when chunk metadata has changed but chunk text has
   * not — e.g. extracted attributes have been added on a subsequent
   * run against an already-persisted document. Chunk IDs shift on a
   * forced run.
   */
  readonly force?: boolean;
}

interface DocumentRow {
  readonly id: string;
  readonly content_hash: string;
}

async function upsertDocument(
  supabase: SupabaseClient,
  document: DocumentInput,
): Promise<{ id: string; wasNew: boolean; hashChanged: boolean }> {
  const { data: existing, error: selectError } = await supabase
    .from('documents')
    .select('id, content_hash')
    .eq('source', document.source)
    .eq('source_ref', document.sourceRef)
    .maybeSingle<DocumentRow>();

  if (selectError) {
    throw new Error(`document select failed: ${selectError.message}`);
  }

  const payload = {
    source: document.source,
    source_ref: document.sourceRef,
    title: document.title,
    url: document.url,
    content_type: document.contentType,
    language: document.language,
    content_hash: document.contentHash,
    metadata: document.metadata,
  };

  if (existing) {
    const hashChanged = existing.content_hash !== document.contentHash;
    if (hashChanged) {
      const { error: updateError } = await supabase
        .from('documents')
        .update(payload)
        .eq('id', existing.id);
      if (updateError) {
        throw new Error(`document update failed: ${updateError.message}`);
      }
    }
    return { id: existing.id, wasNew: false, hashChanged };
  }

  const { data: inserted, error: insertError } = await supabase
    .from('documents')
    .insert(payload)
    .select('id')
    .single<{ id: string }>();
  if (insertError || !inserted) {
    throw new Error(`document insert failed: ${insertError?.message ?? 'no row returned'}`);
  }
  return { id: inserted.id, wasNew: true, hashChanged: true };
}

async function replaceChunks(
  supabase: SupabaseClient,
  documentId: string,
  chunks: readonly ChunkInput[],
): Promise<readonly string[]> {
  const { error: deleteError } = await supabase
    .from('chunks')
    .delete()
    .eq('document_id', documentId);
  if (deleteError) {
    throw new Error(`chunk delete failed: ${deleteError.message}`);
  }

  if (chunks.length === 0) {
    return [];
  }

  // ADR-0013: pass explicit deterministic `id` on each insert rather
  // than relying on the `gen_random_uuid()` default. Same inputs
  // (document_id, ordinal, text) → same UUID, across any re-ingest.
  // This is what makes chunk IDs durable references — golden set
  // rows, trace logs, staff-console review artefacts all keep
  // pointing at the same chunk after re-ingesting unchanged content.
  const rows = chunks.map((chunk) => ({
    id: computeChunkId(documentId, chunk.ordinal, chunk.text),
    document_id: documentId,
    ordinal: chunk.ordinal,
    parent_chunk_id: null,
    text: chunk.text,
    token_count: chunk.tokenCount,
    metadata: chunk.metadata,
    // Cast is deliberate. supabase-js types the embedding column
    // (which is pgvector `vector(1536)`) as string on the wire, but
    // PostgREST accepts the JSON array natively. See ADR-0001 for
    // model commitment; see the GW-01 embedding-gap post-mortem for
    // why writing NULL here silently kills recall.
    embedding: (chunk.embedding ?? null) as unknown as string | null,
  }));

  // `upsert(onConflict: 'id')` gives us idempotence: if the previous
  // DELETE above didn't actually clear the row (partial delete, or
  // for whatever reason the same id already exists), the upsert
  // updates in place instead of throwing on duplicate PK. In the
  // normal path the DELETE cleared the space and this behaves like
  // an insert. Belt-and-braces for the half-done recovery case
  // named in ADR-0013.
  const { data: inserted, error: insertError } = await supabase
    .from('chunks')
    .upsert(rows, { onConflict: 'id' })
    .select('id, ordinal');
  if (insertError || !inserted) {
    throw new Error(`chunk upsert failed: ${insertError?.message ?? 'no rows returned'}`);
  }

  const sorted = [...inserted].sort((a, b) => Number(a['ordinal']) - Number(b['ordinal']));
  return sorted.map((row) => String(row['id']));
}

export async function persistDocumentWithChunks(
  supabase: SupabaseClient,
  documentWithChunks: DocumentWithChunks,
  options: PersistOptions = {},
): Promise<PersistResult> {
  const { document, chunks } = documentWithChunks;
  const { id, wasNew, hashChanged } = await upsertDocument(supabase, document);
  const shouldReplaceChunks = wasNew || hashChanged || options.force === true;
  if (!shouldReplaceChunks) {
    // Existing document with matching content hash — skip chunk replacement.
    // The eval harness reads chunk IDs stably across runs; not touching
    // chunks when the content is unchanged keeps those references valid.
    // Callers pass `{ force: true }` when chunk metadata has changed but
    // text has not (e.g. extracted attributes added post-hoc).
    const { data: existingChunks, error } = await supabase
      .from('chunks')
      .select('id, ordinal')
      .eq('document_id', id)
      .order('ordinal', { ascending: true });
    if (error) {
      throw new Error(`chunk read failed: ${error.message}`);
    }
    return {
      documentId: id,
      chunkIds: (existingChunks ?? []).map((row) => String(row['id'])),
      action: 'unchanged',
    };
  }
  const chunkIds = await replaceChunks(supabase, id, chunks);
  const action: PersistResult['action'] = wasNew ? 'inserted' : hashChanged ? 'updated' : 'forced';
  return { documentId: id, chunkIds, action };
}
