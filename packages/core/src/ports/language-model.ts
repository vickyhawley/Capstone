/**
 * LanguageModel port.
 *
 * Streaming chat completion abstraction. Kept deliberately narrow — no
 * provider-specific options bleed through. If a real adapter needs
 * provider-only knobs it may accept them via a discriminated `providerOptions`
 * field, but core will never inspect them.
 *
 * Assumes:
 * - Callers pass an `AbortSignal` and honour cancellation. The per-request
 *   time budget in `apps/api` is enforced via this signal.
 * - Adapters may batch tokens for efficiency; a single yielded chunk MAY
 *   contain multiple tokens.
 * - Adapters MUST NOT invent tool calls — tool routing happens above this
 *   port via `ToolRegistry`.
 */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  readonly role: Role;
  readonly content: string;
  readonly name?: string;
}

export interface CompletionRequest {
  readonly messages: readonly Message[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export interface CompletionChunk {
  readonly delta: string;
  readonly done: boolean;
  readonly finishReason?: 'stop' | 'length' | 'safety' | 'cancelled';
}

export interface LanguageModel {
  complete(request: CompletionRequest): AsyncIterable<CompletionChunk>;
}
