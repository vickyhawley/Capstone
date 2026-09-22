/**
 * Supabase-backed ConversationStore. GW-16, ADR-0017.
 *
 * One row per conversation in `conversations` (migration 005) with
 * history as a JSONB array. `appendTurn` is a transactional
 * read-modify-write: fetch the row, append the new turn to
 * `history`, bump `turn_count` and `updated_at`, write back.
 * Concurrent appends to the same conversation race — mitigated by
 * client-side serialisation (one in-flight request per conversation
 * enforced by the web app) and by the port docstring naming this
 * assumption explicitly.
 *
 * Not-found handling in `get()`: returns `null`. A stale client-
 * side conversation_id (browser reload after retention rotation)
 * is a legitimate case and should NOT throw. Callers treat null
 * as "start a fresh conversation".
 */
import type {
  Conversation,
  ConversationStore,
  ConversationTurn,
} from '@groundwork/core';
import type { SupabaseClient } from '@supabase/supabase-js';

interface ConversationRow {
  readonly id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly turn_count: number;
  readonly history: readonly ConversationTurn[];
}

export class SupabaseConversationStore implements ConversationStore {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(): Promise<Conversation> {
    const { data, error } = await this.supabase
      .from('conversations')
      .insert({})
      .select('id, created_at, updated_at, turn_count, history')
      .single();
    if (error) {
      throw new Error(`SupabaseConversationStore.create failed: ${error.message}`);
    }
    return rowToConversation(data as ConversationRow);
  }

  async get(id: string): Promise<Conversation | null> {
    const { data, error } = await this.supabase
      .from('conversations')
      .select('id, created_at, updated_at, turn_count, history')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      throw new Error(`SupabaseConversationStore.get failed: ${error.message}`);
    }
    if (!data) return null;
    return rowToConversation(data as ConversationRow);
  }

  async appendTurn(id: string, turn: ConversationTurn): Promise<void> {
    // Read-modify-write. Not transactional in Postgres — a competing
    // append against the same id can lose data. Documented in the
    // port contract; enforced by client serialisation.
    const current = await this.get(id);
    if (!current) {
      throw new Error(`SupabaseConversationStore.appendTurn: conversation ${id} not found`);
    }
    const nextHistory = [...current.history, turn];
    const { error } = await this.supabase
      .from('conversations')
      .update({
        history: nextHistory,
        turn_count: nextHistory.length,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) {
      throw new Error(`SupabaseConversationStore.appendTurn failed: ${error.message}`);
    }
  }
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    turnCount: row.turn_count,
    history: row.history,
  };
}
