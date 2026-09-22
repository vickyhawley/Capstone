/**
 * Context-aware query rewriter — GW-16, ADR-0017.
 *
 * Turns an ambiguous follow-up ("do you have anything else similar")
 * into a self-contained query ("do you have anything similar to
 * hemp bedding") using the last N turns of conversation history.
 * Runs BEFORE the router so the existing 6-class descriptive
 * classifier (ADR-0010) doesn't need to grow context awareness.
 *
 * When there is no history, or the query is already self-contained,
 * the rewriter passes the query through unchanged — the model is
 * instructed to make no change unless referents genuinely need
 * resolving.
 *
 * Model: gpt-4o-mini (same tier as the router's LLM classifier).
 * Rewrite cost is ~200 input tokens + ~30 output tokens per turn
 * with history; well under the classifier's cost. Ships as a
 * separate module (not folded into HybridRouter) so the router
 * stays single-responsibility and testable without an LLM stub.
 */
import { CircuitOpenError, type CircuitBreaker, type ConversationTurn } from '@groundwork/core';
import type OpenAI from 'openai';

export const REWRITER_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = `You rewrite short follow-up questions from a customer at an equine retail shop so they stand alone without conversation context.

Rules:
- If the current question already stands alone (mentions concrete products, postcodes, hours, prices), return it VERBATIM. Do not paraphrase, do not "improve" it.
- If the current question uses pronouns ("it", "them", "this") or comparatives ("similar", "cheaper", "else", "another") that only make sense given prior turns, rewrite it to resolve the referent using the most recent user turn or the last assistant answer.
- Preserve the customer's original phrasing style. Do not add politeness or restructure.
- Output ONLY the rewritten question, one line, no quotes, no explanation.
- Do NOT invent details not present in the history or the current question.`;

/**
 * How many recent turns to consider when resolving referents. Two
 * turns (one user + one assistant) is usually enough to resolve
 * the pronoun in the very next user follow-up. Longer conversations
 * can address by name — the model doesn't need the full history to
 * disambiguate "do you have anything else similar" if the
 * immediately-prior turn discussed hemp bedding.
 */
const CONTEXT_WINDOW = 4;

export interface ContextRewriterDeps {
  readonly openai: OpenAI;
  /** Optional circuit breaker wrapping the OpenAI call. GW-23
   * pattern — on open, we return the query unchanged rather than
   * throwing, because the router below is degrade-tolerant and a
   * failed rewrite should not fail the whole turn. */
  readonly openaiBreaker?: CircuitBreaker;
}

/**
 * Rewrite `query` in light of `history`. Returns the (possibly
 * unchanged) query text. Never throws — on any error the original
 * query is returned unchanged, matching the port's "best-effort
 * improvement, not a load-bearing gate" contract.
 */
export async function rewriteWithContext(
  query: string,
  history: readonly ConversationTurn[],
  deps: ContextRewriterDeps,
): Promise<string> {
  if (history.length === 0) return query;

  const window = history.slice(-CONTEXT_WINDOW);
  const historyBlock = window
    .map((turn) => `${turn.role === 'user' ? 'Customer' : 'Assistant'}: ${turn.text}`)
    .join('\n');

  const userPrompt = `Recent conversation:\n${historyBlock}\n\nCurrent customer question: ${query}\n\nRewritten (or verbatim if already self-contained):`;

  const call = async () => {
    return deps.openai.chat.completions.create({
      model: REWRITER_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 120,
    });
  };

  try {
    const res = deps.openaiBreaker ? await deps.openaiBreaker.run(call) : await call();
    const raw = res.choices[0]?.message?.content?.trim();
    if (!raw) return query;
    // Strip surrounding quotes if the model added them despite the
    // instruction.
    const cleaned = raw.replace(/^["']|["']$/g, '').trim();
    return cleaned || query;
  } catch (err) {
    // Any failure — including CircuitOpenError — degrades to the
    // original query. The router downstream will do its best with
    // what it has; if the follow-up genuinely needed context, it
    // will hit the same false-refusal path as before. Not worse
    // than the pre-rewrite baseline.
    if (!(err instanceof CircuitOpenError)) {
      // Non-breaker failures are unexpected — log but don't throw.
      console.warn('context-rewriter: LLM call failed, using original query', err);
    }
    return query;
  }
}
