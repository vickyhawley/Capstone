/**
 * Synthesizer port. Sprint 4.
 *
 * Composes the customer-facing `answer` copy for `answer`-behaviour
 * turns. Reads the tool loop's outputs + the router's classification
 * and produces grounded text. Downstream of the tool loop, upstream
 * of `/api/answer`'s JSON serialization.
 *
 * Non-goals for MVP:
 *
 * - Streaming. The port returns a full string. A future
 *   `StreamingSynthesizer` port (or an amendment to this one) can add
 *   token-level streaming when the UI wants it. Today's UI can render
 *   the whole answer at once.
 * - Raw-chunk citations. Sources today are the tool results — the
 *   tools already ran retrieval internally and hydrated
 *   product/district metadata. When `/api/answer` runs its own
 *   retrieval pass (Sprint 4+), the port will grow a
 *   `retrievedChunks` input and a `citations` output. Named on the
 *   input shape so the future field slots in without a port break.
 * - Prohibited-claim enforcement beyond prompt-side instruction.
 *   The synthesizer's system prompt names the constraints; a
 *   post-check + regenerate loop is a Sprint 4+ hardening story.
 *
 * Failure contract: the adapter throws on infra failure (LLM 5xx,
 * network partition). `/api/answer` catches at the request boundary
 * and returns the graceful-escalate response (GW-23). Business-level
 * failures (LLM returned an empty or malformed response) return a
 * `SynthesizerOutput` with a fallback answer string rather than
 * throw — the tool results already contain the useful information;
 * a defensive fallback ("The shop can help you with this — give us
 * a call") is better than nothing.
 */
import type { ConversationTurn } from './conversation-store.js';
import type { ToolInvocationRecord } from './planner.js';
import type { RouterDecision, RouterQuery } from './router.js';

export interface SynthesizerInput {
  readonly query: RouterQuery;
  readonly routerDecision: RouterDecision;
  readonly toolResults: readonly ToolInvocationRecord[];
  /** GW-16: prior turns in the conversation, oldest first. Empty for
   *  turn 1. Adapters interleave these into the OpenAI messages
   *  array so answers stay coherent across the conversation (no
   *  repeating a caveat the customer already acknowledged, no
   *  contradicting an earlier statement). Optional — pre-GW-16
   *  tests pass without it and get single-turn behaviour. */
  readonly history?: readonly ConversationTurn[];
}

export interface SynthesizerOutput {
  /** Customer-facing answer copy. Never empty on a successful call —
   *  the adapter falls back to a canned string rather than return ''. */
  readonly answer: string;
  /** Optional short trace of what the model was told to work with.
   *  Populated for observability / debugging; consumers may ignore. */
  readonly rationale?: string;
}

/**
 * One increment of the streaming answer. `text` is the delta since
 * the last emission (not the cumulative answer) — the caller
 * concatenates as they arrive. `done` is true only on the final
 * delta; if the caller needs the full answer at the end it should
 * accumulate deltas itself.
 *
 * A stream that fails infra-side throws from the AsyncIterable's
 * next() — same contract as `synthesize()`. Empty-content and
 * malformed-response fallbacks come out as a single delta with the
 * canned fallback text.
 */
export interface SynthesizerDelta {
  readonly text: string;
  readonly done: boolean;
}

export interface Synthesizer {
  /** Non-streaming: returns the full answer as one string. Used by
   *  the JSON /api/answer route + the Python eval harness. */
  synthesize(input: SynthesizerInput): Promise<SynthesizerOutput>;

  /** Streaming: yields deltas as the model produces them. Used by
   *  the SSE /api/answer/stream route + the browser chat UI so
   *  answers form live rather than landing all at once. Adapters
   *  MUST implement both — a common pattern is a thin `synthesize`
   *  that collects the stream (see StubSynthesizer). */
  synthesizeStream(input: SynthesizerInput): AsyncIterable<SynthesizerDelta>;
}
