/**
 * In-memory ConversationStore for tests and local dev. Matches the
 * Supabase adapter's semantics; state is lost when the process
 * exits.
 *
 * `get()` for an unknown id returns null (not throw) — same as the
 * Supabase adapter and consistent with the port contract.
 * `appendTurn` for an unknown id throws — a conversation must
 * exist before you can append to it, which the API layer enforces
 * by always calling `create()` first when no id is supplied.
 */
import type {
  Conversation,
  ConversationStore,
  ConversationTurn,
} from '@groundwork/core';

interface MutableConversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  history: ConversationTurn[];
}

export class StubConversationStore implements ConversationStore {
  private readonly rows = new Map<string, MutableConversation>();
  private counter = 0;

  async create(): Promise<Conversation> {
    this.counter += 1;
    const id = `stub-conv-${this.counter.toString().padStart(4, '0')}`;
    const now = new Date().toISOString();
    const row: MutableConversation = {
      id,
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      history: [],
    };
    this.rows.set(id, row);
    return snapshot(row);
  }

  async get(id: string): Promise<Conversation | null> {
    const row = this.rows.get(id);
    return row ? snapshot(row) : null;
  }

  async appendTurn(id: string, turn: ConversationTurn): Promise<void> {
    const row = this.rows.get(id);
    if (!row) {
      throw new Error(`StubConversationStore.appendTurn: conversation ${id} not found`);
    }
    row.history.push(turn);
    row.turnCount = row.history.length;
    row.updatedAt = new Date().toISOString();
  }
}

function snapshot(row: MutableConversation): Conversation {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    turnCount: row.turnCount,
    history: [...row.history],
  };
}
