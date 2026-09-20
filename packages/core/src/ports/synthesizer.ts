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
import type { ToolInvocationRecord } from './planner.js';
import type { RouterDecision, RouterQuery } from './router.js';

export interface SynthesizerInput {
  readonly query: RouterQuery;
  readonly routerDecision: RouterDecision;
  readonly toolResults: readonly ToolInvocationRecord[];
}

export interface SynthesizerOutput {
  /** Customer-facing answer copy. Never empty on a successful call —
   *  the adapter falls back to a canned string rather than return ''. */
  readonly answer: string;
  /** Optional short trace of what the model was told to work with.
   *  Populated for observability / debugging; consumers may ignore. */
  readonly rationale?: string;
}

export interface Synthesizer {
  synthesize(input: SynthesizerInput): Promise<SynthesizerOutput>;
}
