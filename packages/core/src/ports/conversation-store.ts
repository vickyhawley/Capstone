/**
 * ConversationStore port — GW-16 conversation memory.
 *
 * Persists multi-turn conversation history so ambiguous follow-up
 * queries ("do you have anything else similar") can be interpreted
 * with context from prior turns. See ADR-0017 for the design decision
 * that state lives server-side (single Supabase row per conversation,
 * JSONB history array) rather than client-carried.
 *
 * Assumes:
 * - Clients never mint their own conversation IDs. `create()` returns
 *   a server-generated UUID; every subsequent request quotes it.
 * - Concurrent `appendTurn` calls to the same conversation race.
 *   Callers must serialise (the web app enforces one in-flight request
 *   per conversation via UI pending state; other clients must do
 *   likewise or accept last-write-wins).
 * - History carries verbatim user queries and final assistant answers.
 *   Intermediate SSE deltas, tool-call payloads, and reasoning tokens
 *   are NOT recorded here — those belong on the trace sink (ADR-0015).
 * - PII redaction happens before this port. Adapters do not scan.
 */

export type ConversationRole = 'user' | 'assistant';

/**
 * One turn in a conversation. `turnId` is stable across replays so
 * trace records can point at a specific turn without re-hashing.
 * `createdAt` is ISO-8601 UTC, matching the trace-sink convention.
 */
export interface ConversationTurn {
  readonly turnId: string;
  readonly role: ConversationRole;
  readonly text: string;
  readonly createdAt: string;
}

export interface Conversation {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly history: readonly ConversationTurn[];
}

export interface ConversationStore {
  /**
   * Create an empty conversation. Returns the newly-issued id and
   * timestamps. First-turn semantics: caller then invokes
   * `appendTurn` for the user query and again for the assistant
   * answer.
   */
  create(): Promise<Conversation>;

  /**
   * Load a conversation by id. Returns null if the id is unknown —
   * callers should treat that as "start a fresh conversation" rather
   * than as an error, since a stale client-side id (browser reload
   * after retention rotation) is a legitimate case.
   */
  get(id: string): Promise<Conversation | null>;

  /**
   * Append one turn. Updates `updated_at` and increments
   * `turn_count`. Adapters must implement this as an atomic
   * read-modify-write against the underlying store; the port
   * contract is single-turn append, not batch.
   */
  appendTurn(id: string, turn: ConversationTurn): Promise<void>;
}
